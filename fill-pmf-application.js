 const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;
const http = require('http');
const nodemailer = require('nodemailer');
const fs = require('fs');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';
const SUBMISSION_WEBHOOK_SECRET = process.env.SUBMISSION_WEBHOOK_SECRET; // must match the secret in the Apps Script

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

const ENTITY_TYPE_MAP = {
  'LLC': 'Limited Liability Company (LLC)',
  'PLLC': 'Professional Limited Liability Company (PLLC)',
  'INC': 'C Corporation (C Corp)',
  'CORP': 'C Corporation (C Corp)',
};

const STATE_NAME_MAP = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

function toStateName(code) {
  if (!code) return code;
  const trimmed = code.trim();
  return STATE_NAME_MAP[trimmed.toUpperCase()] || trimmed; // pass through if already a full name
}

const NO_WEBSITE_PLACEHOLDERS = ['na', 'n/a', 'n.a.', 'none', 'nowebsite', 'nowebsite.com', 'no website', 'n a'];
function hasRealWebsite(value) {
  if (!value) return false;
  const cleaned = value.trim();
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  if (NO_WEBSITE_PLACEHOLDERS.includes(lower)) return false;
  if (lower.includes('does not have') || lower.includes('no website')) return false;
  if (/\s/.test(cleaned)) return false; // real domains never contain spaces
  if (!cleaned.includes('.')) return false; // real domains always contain a dot
  return true;
}

// ---------- email ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

async function sendReadyToSignEmail(applicantName, liveViewUrl) {
  if (!process.env.EMAIL_USER || !process.env.NOTIFY_EMAIL) {
    console.log('Email not configured, skipping notification.');
    return;
  }
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `PMF Application Ready to Sign — ${applicantName}`,
    html: `<p>The PMF application for <b>${applicantName}</b> has been filled out (Steps 1-3) and the consent box checked.</p>
           <p><a href="${liveViewUrl}"><b>Click here to open the live form and sign</b></a></p>
           <p>Draw the signature and click Submit.</p>`,
  });
  console.log(`Notification email sent for ${applicantName}`);
}

// ---------- field mapping ----------
function formatDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return iso; // already formatted or unrecognized, pass through
}

function yesNo(v) {
  return /^y(es)?$/i.test(String(v || '').trim());
}

function mapAnswersToApplicant(a) {
  return {
    firstName: a['First Name'] || '',
    lastName: a['Last Name'] || '',
    dob: formatDate(a['Date of Birth']),
    ssn: a['Social Security Number'] || '',
    email: a['Email'] || '',
    cellPhone: a['Phone Number'] || '',
    businessName: a['Company Name'] || '',
    businessStartDate: formatDate(a['Business Starting Date']),
    industry: a['Business Industry'] || '',
    ein: a['EIN'] || '',
    website: a['Website'] || a['Company Website'] || '',
    businessPhone: a['Phone Number'] || '',
    ficoScore: a['Credit Score?'] || a['Credit Score'] || '',
    ownershipPct: '100', // hardcoded — this form requires partner info below 100%, which we don't collect
    employeeCount: a['Number of Employees?'] || a['Number of Employees'] || '1',
    amountRequested: a['Financing Amount?'] || a['Financing Amount'] || '',
    // NOTE: each of these now checks multiple possible spellings of the question text
    // (with/without trailing "?", with/without a space in "home based"), because a single
    // exact-key miss here silently reads as blank -> false ("NO") instead of erroring.
    processCreditCards: yesNo(
      a['Processes Credit Cards?'] || a['Processes Credit Cards']
    ),
    ownsMultipleBusinesses: yesNo(
      a['Do you own multiple businesses?'] || a['Do you own multiple businesses']
    ),
    isHomeBased: yesNo(
      a['Is your business homebased?'] ||
      a['Is your business homebased'] ||
      a['Is your business home based?'] ||
      a['Is your business home based']
    ),
    ownsHomeProperty: yesNo(
      a['Do you own a home property?'] || a['Do you own a home property']
    ),
    stateOfIncorporation: a['State'] || '',
    entityType: a['Entity Type'] || '',
    addressLine1: a['Address 1'] || '',
    addressLine2: a['Address 2'] || '',
    city: a['City'] || '',
    state: a['State'] || '',
    zip: a['Zip'] || '',
  };
}

// ---------- form filling (unchanged logic from the working version) ----------
async function fillPmfApplication(applicant, bankFilePaths) {
  const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(PMF_URL, { waitUntil: 'networkidle' });

  // Step 1 — Contact Info
  await page.fill('#apply-firstName', applicant.firstName);
  await page.fill('#apply-lastName', applicant.lastName);
  await page.fill('#apply-dateOfBirth', applicant.dob);
  await page.fill('#apply-ssn', applicant.ssn);
  await page.fill('#apply-email', applicant.email);
  await page.fill('#apply-cellPhone', applicant.cellPhone);
  await page.fill('#apply-businessName', applicant.businessName);
  const userAgreement = await page.$('#user-agreement');
  if (userAgreement) await userAgreement.check();
  await page.click('button:has-text("Next")');
  await page.waitForSelector('#businessStartedAt', { timeout: 15000 });
  console.log('[FILL] Step 1 done, Step 2 loaded');

  // Step 2 — Business Details
  await page.fill('#businessStartedAt', applicant.businessStartDate);
  await fillCombobox(page, '#businessBusinessType', applicant.industry);
  if (applicant.stateOfIncorporation) await fillCombobox(page, '#businessStateOfIncorporation', toStateName(applicant.stateOfIncorporation));
  await page.fill('#businessFederalTaxId', applicant.ein);
  if (hasRealWebsite(applicant.website)) {
    await page.fill('#businessWebsite', applicant.website);
    console.log('[FILL] Website filled:', applicant.website);
  } else {
    let checked = false;
    try {
      await page.getByRole('checkbox', { name: /does not have a website/i }).check({ timeout: 5000 });
      checked = true;
    } catch (e) {
      console.log('[FILL] getByRole checkbox failed, trying label-click fallback:', e.message);
    }
    if (!checked) {
      try {
        await page.getByText(/does not have a website/i).first().click({ timeout: 5000 });
        checked = true;
      } catch (e2) {
        console.log('[FILL] Label-click fallback also failed (non-fatal):', e2.message);
      }
    }
    if (checked) {
      await page.waitForTimeout(500); // let the page clear the website field's "required" state
      try {
        await page.click('#businessWebsite');
        await page.keyboard.press('Tab'); // blur the field so it re-validates as no-longer-required
      } catch (e3) {
        // non-fatal
      }
      await page.waitForTimeout(300);
      console.log('[FILL] No website provided, checked "does not have a website"');
    }
  }
  await page.fill('#businessPhone', applicant.businessPhone);
  await page.fill('#fico', applicant.ficoScore);
  await page.fill('#ownership', applicant.ownershipPct);
  await page.fill('#businessEmployeesCount', applicant.employeeCount);
  if (applicant.amountRequested) await page.fill('#amountRequestedCents', applicant.amountRequested);
  if (applicant.entityType) {
    // The sheet already contains the exact PMF label (e.g. "Limited Liability Company (LLC)").
    // Fall back to the LLC/INC/CORP -> label map only if a raw code slipped through instead.
    const looksLikeRawCode = /^[A-Z]{2,5}$/.test(applicant.entityType.trim());
    const entityTypeLabel = looksLikeRawCode
      ? (ENTITY_TYPE_MAP[applicant.entityType.toUpperCase()] || applicant.entityType)
      : applicant.entityType;
    await fillCombobox(page, '#businessEntityType', entityTypeLabel);
  }
  await setToggle(page, '#businessProcessCreditCards', applicant.processCreditCards);
  await setToggle(page, '#businessMultipleBusinessesOwner', applicant.ownsMultipleBusinesses);
  await setToggle(page, '#businessHomeBased', applicant.isHomeBased);
  if (applicant.addressLine1) await page.fill('#businessAddressLine1', applicant.addressLine1);
  if (applicant.addressLine2) await page.fill('#businessAddressLine2', applicant.addressLine2);
  if (applicant.city) await page.fill('#businessCity', applicant.city);
  if (applicant.state) await fillCombobox(page, '#businessState', toStateName(applicant.state));
  if (applicant.zip) await page.fill('#businessZipCode', applicant.zip);
  await setToggle(page, '#merchantHomePropertyOwner', applicant.ownsHomeProperty);
  await page.click('button:has-text("Next")');
  console.log('[FILL] Step 2 done, moving to Step 3');

  // Step 3 — File Upload
  await page.waitForTimeout(2000);
  if (bankFilePaths && bankFilePaths.length > 0) {
    try {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(bankFilePaths);
      console.log(`[FILL] Uploaded ${bankFilePaths.length} bank statement file(s)`);
    } catch (e) {
      console.log('[FILL] File upload failed (non-fatal):', e.message);
    }
  }
  await page.click('button:has-text("Next")');
  console.log('[FILL] Step 3 done, moving to Step 4');

  // Step 4 — Consent, stop before signature
  await page.waitForTimeout(2000);
  const shareInfoCheckbox = await page.$('#isAgreeWithShareInformation');
  if (shareInfoCheckbox) {
    const checked = await shareInfoCheckbox.isChecked();
    if (!checked) await shareInfoCheckbox.check();
  }
  console.log(`[FILL] Done for ${applicant.firstName} ${applicant.lastName}. Waiting for signature.`);
  const debugUrls = await bb.sessions.debug(session.id);
  const liveViewUrl = debugUrls.debuggerFullscreenUrl || debugUrls.debuggerUrl;
  return liveViewUrl;
}

async function fillCombobox(page, selector, value) {
  if (!value) return;
  try {
    await page.click(selector);
    await page.fill(selector, value);
    await page.waitForTimeout(500);
    const options = page.locator('li[role="option"]');
    const optionTexts = await options.allTextContents();
    console.log(`[FILL] Combobox ${selector} typed "${value}", options seen:`, JSON.stringify(optionTexts));
    const option = options.filter({ hasText: value }).first();
    if (await option.count() > 0) {
      await option.click();
    } else {
      console.log(`[FILL] Combobox ${selector}: no option matched "${value}", leaving unselected`);
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    console.log(`[FILL] Combobox ${selector} failed (non-fatal):`, e.message);
  }
}

async function setToggle(page, selector, shouldBeOn) {
  try {
    const el = await page.$(selector);
    if (!el) { console.log(`[FILL] Toggle ${selector} not found`); return; }
    const isChecked = await el.isChecked();
    console.log(`[FILL] Toggle ${selector}: currently ${isChecked}, want ${shouldBeOn}`);
    if (isChecked !== shouldBeOn) {
      await el.click();
    } else {
      console.log(`[FILL] Toggle ${selector} already at ${shouldBeOn}, clicking twice to register as answered`);
      await el.click();
      await page.waitForTimeout(200);
      await el.click();
    }
  } catch (e) {
    console.log(`[FILL] Toggle ${selector} failed:`, e.message);
  }
}

// ---------- process one submission received from Apps Script ----------
let busy = false; // simple lock so two submissions can't run Playwright at the same time

async function handleSubmission(body, res) {
  if (body.secret !== SUBMISSION_WEBHOOK_SECRET) {
    console.log('[WEBHOOK] Rejected: bad secret');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  // Acknowledge immediately so Apps Script doesn't time out; do the real work after responding.
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, status: 'accepted' }));

  if (busy) {
    console.log('[WEBHOOK] Busy with another submission — this one will still run next, in order.');
  }
  while (busy) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  busy = true;

  try {
    const answers = body.answers || {};
    const files = body.files || [];
    const applicant = mapAnswersToApplicant(answers);
    console.log('[DATA]', JSON.stringify(applicant));

    const bankFilePaths = [];
    for (let i = 0; i < files.length; i++) {
      const tmpPath = `/tmp/bank-${Date.now()}-${i}.pdf`;
      try {
        fs.writeFileSync(tmpPath, Buffer.from(files[i].base64, 'base64'));
        bankFilePaths.push(tmpPath);
      } catch (e) {
        console.log(`[PDF] Failed to write ${files[i].filename}:`, e.message);
      }
    }

    const liveViewUrl = await fillPmfApplication(applicant, bankFilePaths);
    await sendReadyToSignEmail(`${applicant.firstName} ${applicant.lastName}`, liveViewUrl);

    for (const f of bankFilePaths) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  } catch (err) {
    console.error('[ERROR] handleSubmission:', err);
  } finally {
    busy = false;
  }
}

// ---------- HTTP server: health check + webhook ----------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PMF auto-fill service is running.\n');
    return;
  }

  if (req.method === 'POST' && req.url === '/submit') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      handleSubmission(body, res).catch((e) => console.error('[ERROR] handleSubmission crashed:', e));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
}).listen(PORT, () => console.log(`PMF auto-fill service listening on port ${PORT}`));

console.log('PMF auto-fill service started (webhook mode). Waiting for submissions from Apps Script...');
