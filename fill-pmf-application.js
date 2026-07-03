const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;
const http = require('http');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { google } = require('googleapis');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // check for new folders every 2 minutes
const WAIT_BEFORE_PROCESSING_MS = 3 * 60 * 1000; // wait 3 minutes after a folder appears before reading it

const PMF_SUBMISSIONS_FOLDER_ID = process.env.PMF_SUBMISSIONS_FOLDER_ID;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // full JSON key, pasted as one line

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

const ENTITY_TYPE_MAP = {
  'LLC': 'Limited Liability Company (LLC)',
  'PLLC': 'Professional Limited Liability Company (PLLC)',
  'INC': 'C Corporation (C Corp)',
  'CORP': 'C Corporation (C Corp)',
};

// ---------- Google Drive / Sheets auth ----------
const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
const auth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
});
const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

// ---------- health check server (Render needs this) ----------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PMF auto-fill service is running.\n');
}).listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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

// ---------- Google Drive helpers ----------
async function listSubfolders() {
  const res = await drive.files.list({
    q: `'${PMF_SUBMISSIONS_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function listFilesInFolder(folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function readSheetAsMap(spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A:B' });
  const rows = res.data.values || [];
  const map = {};
  // skip header row
  for (const row of rows.slice(1)) {
    const key = (row[0] || '').trim();
    const value = (row[1] || '').trim();
    if (key) map[key] = value;
  }
  return map;
}

async function downloadDriveFileBuffer(fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ---------- field mapping ----------
function formatDate(iso) {
  if (!iso) return '';
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return iso; // already formatted or unrecognized, pass through
}

function yesNo(v) {
  return /^y(es)?$/i.test((v || '').trim());
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
    website: a['Website'] || '',
    businessPhone: a['Phone Number'] || '',
    ficoScore: a['Credit Score?'] || a['Credit Score'] || '',
    ownershipPct: (a['Ownership?'] || a['Ownership'] || '100%').replace('%', ''),
    employeeCount: a['Number of Employees?'] || a['Number of Employees'] || '1',
    amountRequested: a['Financing Amount'] || '',
    processCreditCards: yesNo(a['Processes Credit Cards']),
    ownsMultipleBusinesses: yesNo(a['Do you own multiple businesses?']),
    isHomeBased: yesNo(a['Is your business homebased?']),
    ownsHomeProperty: yesNo(a['Do you own a home property?']),
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
  if (applicant.stateOfIncorporation) await fillCombobox(page, '#businessStateOfIncorporation', applicant.stateOfIncorporation);
  await page.fill('#businessFederalTaxId', applicant.ein);
  if (applicant.website) {
    await page.fill('#businessWebsite', applicant.website);
    console.log('[FILL] Website filled:', applicant.website);
  } else {
    try {
      await page.getByRole('checkbox', { name: /does not have a website/i }).check();
      console.log('[FILL] No website provided, checked "does not have a website"');
    } catch (e) {
      console.log('[FILL] Could not check "no website" checkbox (non-fatal):', e.message);
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

// ---------- Drive polling loop ----------
let processedFolderIds = new Set();
let pendingFolders = []; // folders seen but not yet 3 minutes old
let initialized = false;

async function processSubmissionFolder(folder) {
  console.log(`[PROCESS] ${folder.name} (${folder.id})`);
  const files = await listFilesInFolder(folder.id);
  const sheetFiles = files.filter((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  const pdfFiles = files.filter((f) => f.mimeType === 'application/pdf');

  console.log(`[PROCESS] Found ${sheetFiles.length} sheet(s), ${pdfFiles.length} PDF(s)`);

  let merged = {};
  for (const sheet of sheetFiles) {
    try {
      const map = await readSheetAsMap(sheet.id);
      merged = { ...merged, ...map };
    } catch (e) {
      console.log(`[SHEET] Failed to read ${sheet.name}:`, e.message);
    }
  }

  const applicant = mapAnswersToApplicant(merged);
  console.log('[DATA]', JSON.stringify(applicant));

  const bankFilePaths = [];
  for (let i = 0; i < pdfFiles.length; i++) {
    const tmpPath = `/tmp/bank-${folder.id}-${i}.pdf`;
    try {
      const buffer = await downloadDriveFileBuffer(pdfFiles[i].id);
      fs.writeFileSync(tmpPath, buffer);
      bankFilePaths.push(tmpPath);
    } catch (e) {
      console.log(`[PDF] Download failed for ${pdfFiles[i].name}:`, e.message);
    }
  }

  const liveViewUrl = await fillPmfApplication(applicant, bankFilePaths);
  await sendReadyToSignEmail(`${applicant.firstName} ${applicant.lastName}`, liveViewUrl);

  for (const f of bankFilePaths) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

async function pollDriveFolders() {
  try {
    console.log('[POLL] Checking PMF SUBMISSIONS folder...');
    const folders = await listSubfolders();

    if (!initialized) {
      folders.forEach((f) => processedFolderIds.add(f.id));
      initialized = true;
      console.log(`[INIT] Marked ${folders.length} existing folder(s) as already seen.`);
      return;
    }

    for (const f of folders) {
      const alreadyKnown = processedFolderIds.has(f.id) || pendingFolders.find((p) => p.id === f.id);
      if (!alreadyKnown) {
        console.log(`[POLL] New submission folder detected: ${f.name} — will process in 3 minutes`);
        pendingFolders.push(f);
      }
    }

    const now = Date.now();
    const ready = pendingFolders.filter((f) => now - new Date(f.createdTime).getTime() >= WAIT_BEFORE_PROCESSING_MS);
    pendingFolders = pendingFolders.filter((f) => now - new Date(f.createdTime).getTime() < WAIT_BEFORE_PROCESSING_MS);

    for (const folder of ready) {
      processedFolderIds.add(folder.id);
      try {
        await processSubmissionFolder(folder);
      } catch (e) {
        console.error(`[ERROR] Failed to process folder ${folder.name}:`, e);
      }
    }
  } catch (err) {
    console.error('[ERROR] pollDriveFolders:', err);
  }
}

console.log('PMF auto-fill service started (Google Drive mode). Polling every 2 minutes, 3-minute delay before processing new folders...');
pollDriveFolders();
setInterval(pollDriveFolders, POLL_INTERVAL_MS);
