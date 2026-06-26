const { chromium } = require('playwright');
const fs = require('fs');

const PMF_URL = 'https://apply.myrmapp.com/multi-step-apply/drubin';

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
  await fillCombobox(page, '#businessStateOfIncorporation', applicant.stateOfIncorporation);
  await page.fill('#businessFederalTaxId', applicant.ein);
  await page.fill('#businessWebsite', applicant.website);
  await page.fill('#businessPhone', applicant.businessPhone);
  await page.fill('#fico', applicant.ficoScore);
  await page.fill('#ownership', applicant.ownershipPct);
  await page.fill('#businessEmployeesCount', applicant.employeeCount);
  await page.fill('#amountRequestedCents', applicant.amountRequested);

  await setToggle(page, '#businessProcessCreditCards', applicant.processCreditCards);
  await setToggle(page, '#businessMultipleBusinessesOwner', applicant.ownsMultipleBusinesses);
  await setToggle(page, '#businessHomeBased', applicant.isHomeBased);

  await page.fill('#businessAddressLine1', applicant.addressLine1);
  if (applicant.addressLine2) await page.fill('#businessAddressLine2', applicant.addressLine2);
  await page.fill('#businessCity', applicant.city);
  await fillCombobox(page, '#businessState', applicant.state);
  await page.fill('#businessZipCode', applicant.zip);
  await setToggle(page, '#merchantHomePropertyOwner', applicant.ownsHomeProperty);

  await page.click('button:has-text("Next")');

  const shareInfoCheckbox = await page.$('#isAgreeWithShareInformation');
  if (shareInfoCheckbox) {
    const checked = await shareInfoCheckbox.isChecked();
    if (!checked) await shareInfoCheckbox.check();
  }

  console.log('Steps 1-2 filled, consent checked. Upload documents and sign manually.');
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

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node fill-pmf-application.js applicant.json');
  process.exit(1);
}
const applicant = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
fillPmfApplication(applicant).catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
