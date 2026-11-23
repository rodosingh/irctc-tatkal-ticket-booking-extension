/* eslint-env node */
'use strict';

// The scenarios. Each one is:
//   name      shown in the output; `npm run test:e2e -- <text>` filters on it
//   site      options for the stand-in (see the top of site/standin.js)
//   settings  what the options page would have stored for the extension
//   answers   what the person types into each prompt() the extension raises
//   drive(t)  waits for the extension to get somewhere, or acts as the person
//   verify(t, log)  checks on what the stand-in recorded
//
// Every value here is invented.

const LOGIN_PROMPT = 'Please enter the Captcha:';
const REVIEW_PROMPT = 'Current Seats Status: AVAILABLE-0042\nPlease enter the Captcha:';
const UPI_PROVIDER = 'Pay using BHIM (Powered by PAYTM) also accepts UPI';

const settings = (overrides) => ({
  automationStatus: true,
  username: 'testuser',
  password: 'not-a-real-password',
  targetTime: '09:59:59',
  refreshTime: 500,
  trainNumber: '99123',
  from: 'NGT',
  to: 'SPT',
  quotaType: 'TATKAL',
  isOpeningDayBooking: false,
  accommodationClass: '3A',
  dateString: '2031-03-07',
  paymentType: 'BHIM/UPI',
  paymentMethod: 'BHIM/ UPI/ USSD',
  paymentProvider: 'PAYTM',
  autoPay: false,
  mobileNumber: '0000000000',
  autoUpgradation: true,
  confirmberths: false,
  travelInsuranceOpted: 'no',
  preferredLanguage: 'English',
  masterData: false,
  passengerNames: [],
  passengerList: [
    { id: 1, name: 'Asha Example', age: 34, gender: 'F', preference: 'LB', foodChoice: 'V', isSelected: true },
    { id: 2, name: 'Left Behind', age: 50, gender: 'M', preference: 'MB', foodChoice: 'J', isSelected: false },
    { id: 3, name: 'Ravi Example', age: 61, gender: 'M', preference: 'UB', foodChoice: 'N', isSelected: true },
  ],
  infantList: [],
  showInfant: false,
  autoSolveCaptcha: false,
  autoSubmitCaptcha: false,
  autoProcessPopup: false,
  ...overrides,
});

// ---- reading the stand-in's record ----
const of = (log, type, key) => log.filter((entry) => entry.type === type && entry.key === key);
const submitted = (log, key) => of(log, 'submit', key).map(({ data, accepted }) => (accepted === undefined ? data : { ...data, accepted }));
const clicked = (log, prefix) => log.filter((entry) => entry.type === 'click' && entry.key.startsWith(prefix)).map((entry) => entry.key);
const views = (log) => log.filter((entry) => entry.type === 'view').map((entry) => entry.key);
const byThePerson = (log) => log.filter((entry) => entry.by === 'user').map((entry) => `${entry.type} ${entry.key}`);

// Checks that the steps, written as "<type> <key>", were recorded in this order.
function inOrder(t, name, log, steps) {
  let from = 0;
  for (const step of steps) {
    const at = log.findIndex((entry, index) => index >= from && `${entry.type} ${entry.key}` === step);
    if (at < 0) return t.check(name, false, `missing, or not after the step before it: ${step}`);
    from = at + 1;
  }
  return t.check(name, true);
}

// ---- the whole flow, home page to payment page ----
// `expected` holds what cannot be derived from the settings alone: how the
// stand-in spells the stations, the journey date, the payment type and the
// provider.
function booking(name, { site, overrides, expected }) {
  const s = settings(overrides);
  const timed = s.quotaType !== 'GENERAL';
  const travellers = s.passengerList.filter((passenger) => passenger.isSelected);
  const wallet = s.paymentMethod === 'E-Wallet';
  const prompts = [
    ...(site.loginCaptcha ? [{ type: 'prompt', message: LOGIN_PROMPT, answer: site.loginCaptcha[0] }] : []),
    ...(site.reviewCaptcha ? [{ type: 'prompt', message: REVIEW_PROMPT, answer: site.reviewCaptcha[0] }] : []),
  ];
  const pages = ['home', 'trains', 'passengers', 'review', 'payment'];
  if (s.autoPay) pages.push(...(wallet ? ['ewallet', 'done'] : ['done']));
  const refreshes = site.refreshesBeforeBookable || 0;

  return {
    name,
    site: { clock: '09:30:00', ...site },
    settings: s,
    answers: prompts.map((prompt) => prompt.answer),

    async drive(t) {
      if (timed) {
        await t.until('the quota to be picked', (log) => clicked(log, `journey.quota.option[${s.quotaType}]`).length > 0);
        await t.pause(1500); // the extension reads the page clock once a second
        t.same('search is held back while the page clock is before the target time', submitted(await t.readLog(), 'search'), []);
        await t.setClock('09:59:58');
      }
      if (s.autoPay) return t.until('the end of the flow', (log) => views(log).includes('done'), 45000);
      await t.until('a payment provider to be picked', (log) => clicked(log, 'pay.provider[').length > 0, 45000);
      await t.pause(1000); // long enough for a press on Pay to show up
    },

    verify(t, log) {
      t.same('prompts raised: one per captcha shown, none otherwise', t.dialogs, prompts);
      t.same('pages visited, in order', views(log), pages);
      t.same('everything on the pages was done by the extension, nothing by the test', byThePerson(log), []);

      t.same('journey searched once: first suggested station each way, date as DD/MM/YYYY, quota',
        submitted(log, 'search'), [{ origin: expected.origin, destination: expected.destination, date: expected.date, quota: s.quotaType }]);
      if (timed) {
        const [search] = of(log, 'click', 'journey.search');
        t.check('search is pressed once the page clock reaches the target time',
          Boolean(search) && search.clock >= s.targetTime, `target ${s.targetTime}, pressed at ${search && search.clock}`);
      }

      t.same('one class cell opened: the configured class of the configured train',
        clicked(log, 'train[').filter((key) => key.includes('.class[')), [`train[${s.trainNumber}].class[${s.accommodationClass}]`]);
      t.same(`availability asked again ${refreshes} time(s), through the selected class tab`,
        clicked(log, 'train[').filter((key) => key.includes('.tab[')),
        Array(refreshes).fill(`train[${s.trainNumber}].tab[${s.accommodationClass}]`));
      t.same('Book Now pressed once, for that train, class and the journey date',
        submitted(log, 'book'), [{ train: s.trainNumber, travelClass: s.accommodationClass, date: expected.dateCell }]);

      const forms = submitted(log, 'passengers');
      const form = forms[0] || {};
      t.same('passenger form continued once', forms.length, 1);
      t.same('passenger rows: the selected passengers only, in their order, with name, age, gender, berth and food',
        form.passengers, travellers.map((passenger) => (
          { name: passenger.name, age: String(passenger.age), gender: passenger.gender, berth: passenger.preference, food: passenger.foodChoice })));
      inOrder(t, 'rows filled first to last, each as name, age, gender, berth, food', log,
        travellers.flatMap((_, row) => ['input name', 'input age', 'change gender', 'change berth', 'change food']
          .map((step) => step.replace(' ', ` passenger[${row}].`))));
      t.same('mobile number', form.mobile, s.mobileNumber);
      t.same('preference boxes end up as configured, whatever state the page rendered them in',
        [form.autoUpgradation, form.confirmberths], [s.autoUpgradation, s.confirmberths]);
      t.same('each preference box is clicked only when it differs from the setting',
        [clicked(log, 'autoUpgradation').length, clicked(log, 'confirmberths').length],
        [Number(Boolean(site.autoUpgradationChecked) !== s.autoUpgradation), Number(Boolean(site.confirmBerthsChecked) !== s.confirmberths)]);
      t.same('travel insurance and payment type', [form.insurance, form.paymentType], [s.travelInsuranceOpted, expected.paymentType]);

      t.same(`review continued once, ${site.reviewCaptcha ? 'with the captcha the person gave' : 'with no captcha asked'}`,
        submitted(log, 'review'), [{ captcha: site.reviewCaptcha ? site.reviewCaptcha[0] : '', accepted: true }]);

      t.same('one payment method picked: the configured one', clicked(log, 'pay.method['), [`pay.method[${s.paymentMethod}]`]);
      t.same('one provider picked: the configured one', clicked(log, 'pay.provider['), [`pay.provider[${expected.provider}]`]);
      if (s.autoPay) {
        t.same('Pay pressed exactly once, with that method and provider chosen',
          [clicked(log, 'pay.button').length, submitted(log, 'pay')], [1, [{ method: s.paymentMethod, provider: expected.provider }]]);
        t.same(`wallet confirmation ${wallet ? 'pressed exactly once' : 'never shown'}`, clicked(log, 'ewallet.'), wallet ? ['ewallet.confirm'] : []);
      } else {
        t.same('Pay not pressed', clicked(log, 'pay.button'), []);
      }
    },
  };
}

// The extension starts on the journey form only after the sign-in form has
// gone, and until then a second press on Sign In would have been recorded.
const signedIn = (t) => t.until('the extension to reach the journey form', (log) => of(log, 'input', 'journey.origin').length > 0);

const upiJourney = {
  origin: 'NORTHGATE - NGT',
  destination: 'SOUTHPORT JN - SPT',
  date: '07/03/2031',
  dateCell: 'Fri, 07 Mar',
  paymentType: 'upi',
  provider: UPI_PROVIDER,
};
const twoCaptchas = { loginCaptcha: ['R7KQ2M'], reviewCaptcha: ['H4TXW9'] };

module.exports = [
  {
    name: 'login with a captcha: one prompt, one sign-in',
    site: { loginCaptcha: ['R7KQ2M'] },
    settings: settings(),
    answers: ['R7KQ2M'],
    drive: signedIn,
    verify(t, log) {
      t.same('the person is asked once, by the login prompt', t.dialogs, [{ type: 'prompt', message: LOGIN_PROMPT, answer: 'R7KQ2M' }]);
      t.same('exactly one sign-in, carrying the user id, the password and the captcha typed into the prompt',
        submitted(log, 'login'), [{ userid: 'testuser', password: 'not-a-real-password', captcha: 'R7KQ2M', accepted: true }]);
      inOrder(t, 'language dialog dismissed, login opened, fields filled, then Sign In', log,
        ['click language[English]', 'click header.login', 'input login.userid', 'input login.password', 'input login.captcha', 'click login.submit', 'submit login']);
      t.same('all of it done by the extension', byThePerson(log), []);
    },
  },

  {
    name: 'login without a captcha: signs in by itself',
    // The form keeps a captcha box that is never painted, and no language dialog comes up.
    site: { loginCaptchaUnpainted: true, languagePopup: false },
    settings: settings(),
    drive: signedIn,
    verify(t, log) {
      t.same('no prompt and no alert', t.dialogs, []);
      t.same('exactly one sign-in, carrying the user id and the password and no captcha',
        submitted(log, 'login'), [{ userid: 'testuser', password: 'not-a-real-password', captcha: '', accepted: true }]);
      t.same('the unpainted captcha box is left alone', of(log, 'input', 'login.captcha'), []);
      t.same('all of it done by the extension', byThePerson(log), []);
    },
  },

  {
    name: 'login captcha refused once: the extension does not ask again, the person finishes in the page',
    site: { loginCaptcha: ['R7KQ2M', 'P3WX8D'], loginRejects: 1 },
    settings: settings(),
    answers: ['R7KQ2M'],
    async drive(t) {
      await t.until('the first sign-in', (log) => of(log, 'submit', 'login').length > 0);
      await t.pause(2000); // long enough for a second prompt or a second sign-in to show up
      t.same('after the refusal: one prompt so far, one sign-in so far',
        [t.dialogs.length, of(await t.readLog(), 'submit', 'login').length], [1, 1]);
      // The person reads the new captcha and types it into the page.
      await t.page.locator('app-login #captcha').pressSequentially('P3WX8D');
      await t.page.keyboard.press('Enter');
      await signedIn(t);
    },
    verify(t, log) {
      t.same('one prompt in the whole run', t.dialogs, [{ type: 'prompt', message: LOGIN_PROMPT, answer: 'R7KQ2M' }]);
      t.same('two sign-ins: the refused one, then the one with the new captcha',
        submitted(log, 'login').map(({ captcha, accepted }) => ({ captcha, accepted })),
        [{ captcha: 'R7KQ2M', accepted: false }, { captcha: 'P3WX8D', accepted: true }]);
      t.same('the second one was typed and sent by the person', byThePerson(log), ['input login.captcha', 'click login.submit']);
      inOrder(t, 'the extension resumes with the journey form once signed in', log, ['submit login', 'submit login', 'input journey.origin']);
    },
  },

  {
    name: 'saved passenger list: each selected name is picked from the suggestions',
    site: {
      loginCaptcha: ['R7KQ2M'],
      savedPassengers: [
        { name: 'Asha Example', age: 34, gender: 'F' },
        { name: 'Ravi Example', age: 61, gender: 'M' },
        { name: 'Kiran Example', age: 47, gender: 'T' },
      ],
    },
    settings: settings({
      quotaType: 'GENERAL',
      masterData: true,
      passengerNames: [
        { id: 1, name: 'Ravi Example', isSelected: true },
        { id: 2, name: 'Kiran Example', isSelected: false },
        { id: 3, name: 'Asha Example', isSelected: true },
      ],
    }),
    answers: ['R7KQ2M'],
    drive: (t) => t.until('the passenger form to be continued', (log) => of(log, 'submit', 'passengers').length > 0, 45000),
    verify(t, log) {
      t.same('each selected name picked from the suggestions, one row each, in their order',
        clicked(log, 'passenger[').filter((key) => key.includes('.option[')),
        ['passenger[0].name.option[Ravi Example]', 'passenger[1].name.option[Asha Example]']);
      t.same('rows continued with the age and gender the site filled in, berth and food left alone',
        (submitted(log, 'passengers')[0] || {}).passengers, [
          { name: 'Ravi Example', age: '61', gender: 'M', berth: '', food: '' },
          { name: 'Asha Example', age: '34', gender: 'F', berth: '', food: '' },
        ]);
      t.same('all of it done by the extension', byThePerson(log), []);
    },
  },

  booking('whole flow to the payment page, captcha on review, autoPay off: Pay is not pressed', {
    site: twoCaptchas,
    expected: upiJourney,
  }),

  booking('whole flow with autoPay on: Pay is pressed exactly once', {
    site: twoCaptchas,
    overrides: { autoPay: true },
    expected: upiJourney,
  }),

  // The branches the two runs above do not take: an untimed GENERAL search, a
  // train that is not bookable until availability is asked a second time, one
  // passenger in the row the page starts with, preference boxes that arrive
  // ticked, no captcha on review, and the wallet with its confirmation page.
  booking('whole flow, other branches: one passenger, boxes pre-ticked, no review captcha, wallet confirmed once', {
    site: {
      loginCaptcha: ['R7KQ2M'],
      trains: [{ number: '99123', name: 'STANDIN EXPRESS', classes: ['2A', '3A', 'SL'] }],
      refreshesBeforeBookable: 1,
      autoUpgradationChecked: true,
      confirmBerthsChecked: true,
    },
    overrides: {
      quotaType: 'GENERAL',
      accommodationClass: 'SL',
      passengerList: [{ id: 1, name: 'Meera Example', age: 29, gender: 'F', preference: 'SU', foodChoice: 'G', isSelected: true }],
      travelInsuranceOpted: 'yes',
      paymentType: 'Wallets',
      paymentMethod: 'E-Wallet',
      paymentProvider: 'IRCTC eWallet',
      autoPay: true,
    },
    expected: { ...upiJourney, paymentType: 'cards', provider: 'IRCTC eWallet' },
  }),
];
