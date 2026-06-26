const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;
const http = require('http');
const nodemailer = require('nodemailer');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const UCA_FORM_ID = process.env.UCA_FORM_ID || '243357629795170';
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const SERVICE_START_TIME = Math.floor(Date.now() / 1000);

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

let processedSubmissionIds = new Set();

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
    html: `<p>The PMF application for <b>${applicantName}</b> has been filled out (Steps 1-2) and the consent box checked.</p>
           <p><a href="${liveViewUrl}">Click here to open and review the live form</a></p>
           <p>Upload the bank statements/license, draw the signature, and submit.</p>`,
  });
  console.log(`Notification email sent for ${applicantName}`);
}

async function fetchNewSubmissions() {
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - (10 * 60);
  const url = `https://api.jotform.com/form/${UCA_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=20&orderby=created_at`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(`[FETCH] API returned ${data.content ? data.content.length : 0} total submissions`);
  if (!data.content) return [];
  const filtered = data.content.filter((sub) => {
    const createdTime = Math.floor(new Date(sub.created_at).getTime() / 1000);
    return createdTime >= tenMinutesAgo && !processedSubmissionIds.has(sub.id);
  });
  return filtered;
}

function answerToString(ans) {
  if (ans === undefined || ans === null) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'number' || typeof ans === 'boolean') return String(ans);
  if (typeof ans === 'object') {
    return Object.values(ans).filter(Boolean).join(' ');
  }
  return String(ans);
}

function answerToDate(ans) {
  if (!ans) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'object') {
    const month = ans.month || ans.m;
    const day = ans.day || ans.d;
    const year = ans.year || ans.y;
    if (month && day && year) return `${month}/${day}/${year}`;
  }
  return answerToString(ans);
}

function answerToPhone(ans) {
  if (!ans) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'object') {
    return Object.values(ans).filter(Boolean).join('');
  }
  return answerToString(ans);
}

function mapSubmissionToApplicant(sub) {
  const answers = sub.answers || {};
  const findMatch = (label) => {
    const all = Object.values(answers).filter((a) => a.text === label);
    return all.find((a) => a.answer && (typeof a.answer !== 'object' || Object.keys(a.answer).length)) || all[0];
  };
  const getAnswer = (label) => {
    const match = findMatch(label);
    return match ? answerToString(match.answer) : '';
  };
  const getDate = (label) => {
    const match = findMatch(label);
    return match ? answerToDate(match.answer) : '';
  };
  const getPhone = (label) => {
    const match = findMatch(label);
    return match ? answerToPhone(match.answer) : '';
  };

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
    stateOfIncorporation: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    zip: '',
  };
}

async function fillPmfApplication(applicant) {
  const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(PMF_URL, { waitUntil: 'networkidle' });

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

  await page.fill('#businessStartedAt', applicant.businessStartDate);
  await fillCombobox(page, '#businessBusinessType', applicant.industry);
  if (applicant.stateOfIncorporation) {
    await fillCombobox(page, '#businessStateOfIncorporation', applicant.stateOfIncorporation);
  }
  await page.fill('#businessFederalTaxId', applicant.ein);
  if (applicant.website) await page.fill('#businessWebsite', applicant.website);
  await page.fill('#businessPhone', applicant.businessPhone);
  await page.fill('#fico', applicant.ficoScore);
  await page.fill('#ownership', applicant.ownershipPct);
  await page.fill('#businessEmployeesCount', applicant.employeeCount);
  await page.fill('#amountRequestedCents', applicant.amountRequested);

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

  const shareInfoCheckbox = await page.$('#isAgreeWithShareInformation');
  if (shareInfoCheckbox) {
    const checked = await shareInfoCheckbox.isChecked();
    if (!checked) await shareInfoCheckbox.check();
  }

  console.log(`Steps 1-2 filled for ${applicant.firstName} ${applicant.lastName}. Consent checked.`);

  const debugUrls = await bb.sessions.debug(session.id);
  return debugUrls.debuggerFullscreenUrl || debugUrls.debuggerUrl;
}

async function fillCombobox(page, selector, value) {
  if (!value) return;
  await page.click(selector);
  await page.fill(selector, value);
  await page.waitForTimeout(300);
  const option = page.locator(`li:has-text("${value}")`).first();
  if (await option.count() > 0) await option.click();
  else await page.keyboard.press('Enter');
}

async function setToggle(page, selector, shouldBeOn) {
  const el = await page.$(selector);
  if (!el) return;
  const isChecked = await el.isChecked();
  if (isChecked !== shouldBeOn) await el.click();
}

async function checkForNewSubmissions() {
  try {
    console.log(`[POLL] Checking for new submissions (SERVICE_START_TIME: ${SERVICE_START_TIME})...`);
    const submissions = await fetchNewSubmissions();
    console.log(`[POLL] Fetched ${submissions.length} submissions`);
    for (const sub of submissions) {
      console.log(`New UCA submission found: ${sub.id}`);
      processedSubmissionIds.add(sub.id);
      const applicant = mapSubmissionToApplicant(sub);
      const liveViewUrl = await fillPmfApplication(applicant);
      await sendReadyToSignEmail(`${applicant.firstName} ${applicant.lastName}`, liveViewUrl);
    }
  } catch (err) {
    console.error('Error checking submissions:', err);
  }
}

console.log('PMF auto-fill service started. Polling every 2 minutes...');
checkForNewSubmissions();
setInterval(checkForNewSubmissions, POLL_INTERVAL_MS);
