const { chromium } = require('playwright');
const http = require('http');
const nodemailer = require('nodemailer');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const UCA_FORM_ID = process.env.UCA_FORM_ID || '243357629795170';
const POLL_INTERVAL_MS = 2 * 60 * 1000;

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

async function sendReadyToSignEmail(applicantName) {
  if (!process.env.EMAIL_USER || !process.env.NOTIFY_EMAIL) {
    console.log('Email not configured, skipping notification.');
    return;
  }
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `PMF Application Ready to Sign — ${applicantName}`,
    text: `The PMF application for ${applicantName} has been filled out (Steps 1-2) and the consent box checked. Please open the PMF form, upload the bank statements/license, draw the signature, and submit.`,
  });
  console.log(`Notification email sent for ${applicantName}`);
}

async function fetchNewSubmissions() {
  const url = `https://api.jotform.com/form/${UCA_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=20&orderby=created_at`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.content) return [];
  return data.content.filter((sub) => !processedSubmissionIds.has(sub.id));
}

function mapSubmissionToApplicant(sub) {
  const answers = sub.answers || {};
  const getAnswer = (label) => {
    const match = Object.values(answers).find((a) => a.text === label);
    return match ? match.answer : '';
  };

  return {
    firstName: getAnswer('Legal First Name'),
    lastName: getAnswer('Legal Last Name'),
    dob: getAnswer('Date Of Birth'),
    ssn: getAnswer('Social Security Number'),
    email: getAnswer('Email'),
    cellPhone: getAnswer('Phone Number'),
    businessName: getAnswer('Company Name'),
    businessStartDate: getAnswer('Business Starting Date'),
    industry: getAnswer('Business Industry'),
    ein: getAnswer('EIN'),
    website: getAnswer('Company Website'),
    businessPhone: getAnswer('Phone Number'),
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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
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
  await page.waitForTimeout(800);

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
  try {
    await page.screenshot({ path: `/tmp/${applicant.firstName}-${applicant.lastName}.png`, fullPage: true });
  } catch (e) {
    console.log('Screenshot failed (non-fatal):', e.message);
  }
  await browser.close();
}

async function fillCombobox(page, selector, value) {
  if (!value) return;
  await page.click(selector);
  await page.fill(selector, value);
  await page.waitForTimeout(300);
  const
