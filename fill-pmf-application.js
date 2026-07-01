const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;
const http = require('http');
const nodemailer = require('nodemailer');
const pdf = require('pdf-parse');
const https = require('https');
const fs = require('fs');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const UCA_FORM_ID = process.env.UCA_FORM_ID || '243357629795170';
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

let processedSubmissionIds = new Set();
let initialized = false;

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PMF auto-fill service is running.\n');
}).listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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

async function fetchNewSubmissions() {
  const url = `https://api.jotform.com/form/${UCA_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=50&orderby=created_at&direction=DESC`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.content) return [];

  if (!initialized) {
    data.content.forEach((sub) => processedSubmissionIds.add(sub.id));
    console.log(`[INIT] Marked ${data.content.length} existing submissions as seen.`);
    initialized = true;
    return [];
  }

  return data.content.filter((sub) => !processedSubmissionIds.has(sub.id));
}

function answerToString(ans) {
  if (ans === undefined || ans === null) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'number' || typeof ans === 'boolean') return String(ans);
  if (typeof ans === 'object') return Object.values(ans).filter(Boolean).join(' ');
  return String(ans);
}

function answerToDate(ans) {
  if (!ans) return '';
  if (typeof ans === 'object') {
    const month = ans.month || ans.m;
    const day = ans.day || ans.d;
    const year = ans.year || ans.y;
    if (month && day && year) return `${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}/${year}`;
  }
  if (typeof ans === 'string') {
    const match = ans.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[2]}/${match[3]}/${match[1]}`;
  }
  return '';
}

function answerToPhone(ans) {
  if (!ans) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'object') return Object.values(ans).filter(Boolean).join('');
  return answerToString(ans);
}

function mapSubmissionToApplicant(sub) {
  const answers = sub.answers || {};
  const findMatch = (label) => {
    const all = Object.values(answers).filter((a) => a.text === label);
    return all.find((a) => a.answer && (typeof a.answer !== 'object' || Object.keys(a.answer).length)) || all[0];
  };
  const getAnswer = (label) => { const m = findMatch(label); return m ? answerToString(m.answer) : ''; };
  const getDate = (label) => { const m = findMatch(label); return m ? answerToDate(m.answer) : ''; };
  const getPhone = (label) => { const m = findMatch(label); return m ? answerToPhone(m.answer) : ''; };

  return {
    firstName: getAnswer('Legal First Name'),
    lastName: getAnswer('Legal Last Name'),
    dob: getDate('Date Of Birth'),
    ssn: getAnswer('Social Security Number'),
    email: getAnswer('Email'),
    cellPhone: getPhone('Phone Number'),
    businessName: getAnswer('Company Name'),
    businessStartDate: getDate('Business Starting Date'),
    industry: getAnswer('Business Industry'),
    ein: getAnswer('EIN'),
    website: getAnswer('Company Website'),
    businessPhone: getPhone('Phone Number'),
    ficoScore: getAnswer('Your Credit Score'),
    ownershipPct: '100',
    employeeCount: '1',
    amountRequested: getAnswer('Financing Amount'),
    processCreditCards: getAnswer('Do you process credit cards?') === 'Yes',
    ownsMultipleBusinesses: false,
    isHomeBased: true,
    ownsHomeProperty: false,
    stateOfIncorporation: sub.bankStatementData?.stateOfIncorporation || '',
    entityType: sub.bankStatementData?.entityType || '',
    addressLine1: sub.bankStatementData?.addressLine1 || '',
    addressLine2: '',
    city: sub.bankStatementData?.city || '',
    state: sub.bankStatementData?.state || '',
    zip: sub.bankStatementData?.zip || '',
  };
}

async function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(fileUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function downloadAndExtractBankStatement(pdfUrl) {
  try {
    const dataBuffer = await new Promise((resolve, reject) => {
      https.get(pdfUrl, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
    });
    const data = await pdf(dataBuffer);
    const text = data.text;
    console.log('[PDF] Text sample:', text.substring(0, 200));

    const entityMatch = text.match(/\b(LLC|INC|CORP|PLLC|LP|LLP)\b/i);
    const entityType = entityMatch ? entityMatch[1].toUpperCase() : '';
    const addressMatch = text.match(/(\d+\s[\w\s#.,-]+)\n([\w\s]+),?\s+([A-Z]{2})\s+(\d{5})/);
    const stateMatch = text.match(/\b([A-Z]{2})\b\s+\d{5}/);

    return {
      entityType,
      stateOfIncorporation: addressMatch?.[3] || stateMatch?.[1] || '',
      addressLine1: addressMatch?.[1]?.trim() || '',
      city: addressMatch?.[2]?.trim() || '',
      state: addressMatch?.[3] || stateMatch?.[1] || '',
      zip: addressMatch?.[4] || '',
    };
  } catch (err) {
    console.error('[PDF] Extraction failed:', err.message);
    return null;
  }
}

async function getBankStatementFiles(sub) {
  const answers = sub.answers || {};
  const files = [];
  for (const answer of Object.values(answers)) {
    if (!answer.answer) continue;
    const urls = Array.isArray(answer.answer) ? answer.answer : [answer.answer];
    for (const url of urls) {
      if (typeof url === 'string' && url.includes('jotform.com/uploads') && url.toLowerCase().endsWith('.pdf')) {
        files.push(url);
      }
    }
  }
  return [...new Set(files)];
}

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
  if (applicant.stateOfIncorporation) await fillCombobox(page, '#businessStateOfIncorporation', applicant.stateOfIncorporation);
  await page.fill('#businessFederalTaxId', applicant.ein);
  if (applicant.website) await page.fill('#businessWebsite', applicant.website);
  await page.fill('#businessPhone', applicant.businessPhone);
  await page.fill('#fico', applicant.ficoScore);
  await page.fill('#ownership', applicant.ownershipPct);
  await page.fill('#businessEmployeesCount', applicant.employeeCount);
  if (applicant.amountRequested) await page.fill('#amountRequestedCents', applicant.amountRequested);
  if (applicant.entityType) await fillCombobox(page, '#businessEntityType', applicant.entityType);

  await setToggle(page, '#businessProcessCreditCards', applicant.processCreditCards);
  await setToggle(page, '#businessMultipleBusinessesOwner', applicant.ownsMultipleBusinesses);
  await setToggle(page, '#businessHomeBased', applicant.isHomeBased);

  if (applicant.addressLine1) await page.fill('#businessAddressLine1', applicant.addressLine1);
  if (applicant.addressLine2) await page.fill('#businessAddressLine2', applicant.addressLine2);
  if (applicant.city) await page.fill('#businessCity', applicant.city);
  if (applicant.state) await fillCombobox(page, '#businessState', applicant.state);
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

  // Get live view URL for email
  const debugUrls = await bb.sessions.debug(session.id);
  const liveViewUrl = debugUrls.debuggerFullscreenUrl || debugUrls.debuggerUrl;
  return liveViewUrl;
}

async function fillCombobox(page, selector, value) {
  if (!value) return;
  try {
    await page.click(selector);
    await page.fill(selector, value);
    await page.waitForTimeout(300);
    const option = page.locator(`li:has-text("${value}")`).first();
    if (await option.count() > 0) await option.click();
    else await page.keyboard.press('Enter');
  } catch (e) {
    console.log(`[FILL] Combobox ${selector} failed (non-fatal):`, e.message);
  }
}

async function setToggle(page, selector, shouldBeOn) {
  try {
    const el = await page.$(selector);
    if (!el) return;
    const isChecked = await el.isChecked();
    if (isChecked !== shouldBeOn) await el.click();
  } catch (e) {
    console.log(`[FILL] Toggle ${selector} failed (non-fatal):`, e.message);
  }
}

async function checkForNewSubmissions() {
  try {
    console.log('[POLL] Checking for new submissions...');
    const submissions = await fetchNewSubmissions();
    console.log(`[POLL] Fetched ${submissions.length} new submissions`);

    for (const sub of submissions) {
      console.log(`[POLL] New UCA submission found: ${sub.id}`);
      processedSubmissionIds.add(sub.id);

      const bankUrls = await getBankStatementFiles(sub);
      console.log(`[PDF] Found ${bankUrls.length} PDF file(s)`);

      let bankStatementData = null;
      for (const url of bankUrls) {
        bankStatementData = await downloadAndExtractBankStatement(url);
        if (bankStatementData?.addressLine1) {
          console.log('[PDF] Address extracted:', JSON.stringify(bankStatementData));
          break;
        }
      }
      sub.bankStatementData = bankStatementData;

      const bankFilePaths = [];
      for (let i = 0; i < bankUrls.length; i++) {
        const tmpPath = `/tmp/bank-${sub.id}-${i}.pdf`;
        try {
          await downloadFile(bankUrls[i], tmpPath);
          bankFilePaths.push(tmpPath);
        } catch (e) {
          console.log(`[PDF] Download failed for file ${i}:`, e.message);
        }
      }

      const applicant = mapSubmissionToApplicant(sub);
      console.log('[DATA]', JSON.stringify(applicant));

      const liveViewUrl = await fillPmfApplication(applicant, bankFilePaths);
      await sendReadyToSignEmail(`${applicant.firstName} ${applicant.lastName}`, liveViewUrl);

      for (const f of bankFilePaths) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[ERROR]', err);
  }
}

console.log('PMF auto-fill service started. Polling every 2 minutes...');
checkForNewSubmissions();
setInterval(checkForNewSubmissions, POLL_INTERVAL_MS);
