/* eslint-env node */
'use strict';

// The scenarios. Each one is:
//   name      shown in the output; `npm run test:e2e -- <text>` filters on it
//   site      options for the stand-in (see the top of site/standin.js)
//   settings  what the options page would have stored for the extension
//   drive(t)  acts as the person and waits for the extension to get somewhere
//   verify(t, log)  checks on what the stand-in recorded
//
// Every value here is invented. Where a captcha is shown the test types it in
// the person's place, with the text the scenario gave the stand-in to draw. It
// does not click or focus the captcha box first: the keys go wherever the
// extension left the cursor. (With autoSolveCaptcha on the extension leaves the
// cursor alone, so there the test clicks the box as the person would.)

const NOTE = '#tatkal-captcha-note';
const LOGIN_NOTE = 'Type the captcha and press Enter.';
const LOGIN_RETRY_NOTE = 'A new captcha is shown. Type it and press Enter.';
const SEATS = 'AVAILABLE-0042';
const NO_SEATS = 'not found, check the page';
// The note on the review page: the seat status, then what to do with the
// first captcha or with a later one.
const reviewNote = (seats, again) => `Current Seats Status: ${seats}\n${
  again ? 'A new captcha is shown. Type it' : 'Type the captcha'} and press Enter to continue to payment.`;
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
const signInForm = { userid: 'testuser', password: 'not-a-real-password' };

// ---- reading the stand-in's record ----
const of = (log, type, key) => log.filter((entry) => entry.type === type && entry.key === key);
const submitted = (log, key) => of(log, 'submit', key).map(({ data, accepted }) => (accepted === undefined ? data : { ...data, accepted }));
const clicked = (log, prefix) => log.filter((entry) => entry.type === 'click' && entry.key.startsWith(prefix)).map((entry) => entry.key);
const views = (log) => log.filter((entry) => entry.type === 'view').map((entry) => entry.key);
const byThePerson = (log) => log.filter((entry) => entry.by === 'user').map((entry) => `${entry.type} ${entry.key}`);
// Who pressed a button, press by press: 'script' is the extension; 'user' is
// the person, or the browser submitting the form for them on Enter.
const pressed = (log, key) => of(log, 'click', key).map((entry) => entry.by);
// What was done to these elements and by whom, in order.
const actions = (log, keys) => log.filter((entry) => entry.by && keys.includes(entry.key)).map((entry) => `${entry.type} ${entry.key} ${entry.by}`);

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

// Where in the record a step, written as "<type> <key>", first appears.
const firstAt = (log, step) => log.findIndex((entry) => `${entry.type} ${entry.key}` === step);

// Milliseconds from the first `from` step to the first `to` step after it.
function elapsed(log, from, to) {
  const start = firstAt(log, from);
  const end = log.findIndex((entry, index) => index > start && `${entry.type} ${entry.key}` === to);
  return start < 0 || end < 0 ? NaN : log[end].ms - log[start].ms;
}

// ---- acting as the person ----
// What the person has in front of them: the extension's note, the captcha and
// where the cursor is.
const look = (t) => t.page.evaluate((selector) => {
  const note = document.querySelector(selector);
  const captcha = document.querySelector('app-captcha:not(.unpainted)');
  const cursor = document.activeElement;
  const inView = (el) => {
    const { top, left, bottom, right, width, height } = el.getBoundingClientRect();
    return width > 0 && height > 0 && top >= 0 && left >= 0 && bottom <= window.innerHeight && right <= window.innerWidth;
  };
  const overlap = (a, b) => {
    const p = a.getBoundingClientRect();
    const q = b.getBoundingClientRect();
    return p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
  };
  return {
    note: note && note.textContent,
    noteRole: note && note.getAttribute('role'),
    noteSeen: Boolean(note) && note.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && inView(note),
    noteOverCaptcha: Boolean(note && captcha) && overlap(note, captcha),
    captchaSeen: Boolean(captcha) && inView(captcha),
    cursor: (cursor && cursor.dataset.rec) || null,
  };
}, NOTE);

// Waits until the stand-in has drawn its nth captcha in that box and the
// extension has put the cursor in it. Gives what the person sees then.
async function cursorInCaptcha(t, box, nth = 1) {
  await t.until(`captcha ${nth} of ${box} to be drawn`, (log) => of(log, 'shown', box).length >= nth, 45000);
  return t.until(`the cursor to be put in ${box}`, async () => {
    const seen = await look(t);
    return seen.cursor === box && seen;
  }, 10000);
}

// The checks every captcha step shares, on what the person sees before typing.
function seesNote(t, when, seen, box, text) {
  t.same(`${when}: the cursor is in the captcha box and the note says what to do`, [seen.cursor, seen.note], [box, text]);
  t.check(`${when}: the note is a status message in view, the captcha is in view and not under the note`,
    seen.noteRole === 'status' && seen.noteSeen && seen.captchaSeen && !seen.noteOverCaptcha, JSON.stringify(seen));
}

async function typeAndEnter(t, text) {
  await t.page.keyboard.type(text);
  await t.page.keyboard.press('Enter');
}

// The extension starts on the journey form only after the sign-in form has
// gone, and until then a second press on Sign In would have been recorded.
const signedIn = (t) => t.until('the extension to reach the journey form', (log) => of(log, 'input', 'journey.origin').length > 0);

// ---- the whole flow, home page to payment page ----
// `expected` holds what cannot be derived from the settings alone: how the
// stand-in spells the stations, the journey date, the payment type and the
// provider. `typedOnReview` is what the person types into each captcha the
// review page shows; left out, it is the first one, typed right. Three
// stand-in options add to what is done on the review page: with `seatsAfter`
// the note is read again once the seat status is shown, with
// `seatsWhenRefused` a later note must carry that status, and with a long
// `answerTime` Enter is pressed a second time before the answer comes.
function booking(name, { site, overrides, expected, typedOnReview }) {
  const s = settings(overrides);
  const timed = s.quotaType !== 'GENERAL';
  const travellers = s.passengerList.filter((passenger) => passenger.isSelected);
  const wallet = s.paymentMethod === 'E-Wallet';
  const reviewTyped = typedOnReview || (site.reviewCaptcha ? [site.reviewCaptcha[0]] : []);
  const pages = ['home', 'trains', 'passengers', 'review', 'payment'];
  if (s.autoPay) pages.push(...(wallet ? ['ewallet', 'done'] : ['done']));
  const refreshes = site.refreshesBeforeBookable || 0;

  return {
    name,
    site: { clock: '09:30:00', ...site },
    settings: s,

    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, site.loginCaptcha[0]);
      if (timed) {
        await t.until('the quota to be picked', (log) => clicked(log, `journey.quota.option[${s.quotaType}]`).length > 0);
        await t.pause(1500); // the extension reads the page clock once a second
        t.same('search is held back while the page clock is before the target time', submitted(await t.readLog(), 'search'), []);
        await t.setClock('09:59:58');
      }
      for (const [attempt, text] of reviewTyped.entries()) {
        const seen = await cursorInCaptcha(t, 'review.captcha', attempt + 1);
        const seats = attempt ? site.seatsWhenRefused || SEATS : site.seatsAfter ? NO_SEATS : SEATS;
        seesNote(t, `review, captcha ${attempt + 1}`, seen, 'review.captcha', reviewNote(seats, attempt > 0));
        if (!attempt && site.seatsAfter) {
          await t.until('the seat status to be shown', (log) => of(log, 'shown', 'review.seats').length > 0);
          t.same('the note follows the seat status when the page shows it after the captcha', (await look(t)).note, reviewNote(SEATS, false));
        }
        await typeAndEnter(t, text);
        if (site.answerTime > 3000) {
          await t.pause(site.answerTime - 700); // Continue has not been answered yet
          await t.page.keyboard.press('Enter');
        }
      }
      if (s.autoPay) {
        await t.until('the end of the flow', (log) => views(log).includes('done'), 45000);
      } else {
        await t.until('a payment provider to be picked', (log) => clicked(log, 'pay.provider[').length > 0, 45000);
        await t.pause(1000); // long enough for a press on Pay to show up
      }
      t.same('no note is left on the page', (await look(t)).note, null);
    },

    verify(t, log) {
      t.same('pages visited, in order', views(log), pages);
      t.same('the person typed the captchas and did nothing else', byThePerson(log),
        ['input login.captcha', ...reviewTyped.map(() => 'input review.captcha')]);
      t.same('exactly one sign-in, with the captcha as typed, sent by the extension on Enter',
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: site.loginCaptcha[0], accepted: true }], ['script']]);

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

      if (reviewTyped.length) {
        t.same('review continued once per captcha typed, each as typed, the last one accepted', submitted(log, 'review'),
          reviewTyped.map((captcha, at) => ({ captcha, accepted: at === reviewTyped.length - 1 })));
        const wait = elapsed(log, 'view review', 'focus review.captcha');
        t.check(`the cursor is in the review captcha box ${wait} ms after the page appeared (the pop-up came a second later)`, wait < 1000);
      } else {
        t.same('review continued once, with no captcha asked and the cursor left alone',
          [submitted(log, 'review'), of(log, 'focus', 'review.captcha')], [[{ captcha: '', accepted: true }], []]);
      }
      t.same('Continue on the review page pressed by the extension only, once per captcha',
        pressed(log, 'review.continue'), Array(Math.max(reviewTyped.length, 1)).fill('script'));

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
    name: 'login, captcha typed then Enter: one sign-in',
    site: { loginCaptcha: ['R7KQ2M'] },
    settings: settings(),
    async drive(t) {
      seesNote(t, 'before typing', await cursorInCaptcha(t, 'login.captcha'), 'login.captcha', LOGIN_NOTE);
      await typeAndEnter(t, 'R7KQ2M');
      await signedIn(t);
      t.same('the note is gone once signed in', (await look(t)).note, null);
    },
    verify(t, log) {
      t.same('exactly one sign-in, carrying the user id, the password and the captcha as typed',
        submitted(log, 'login'), [{ ...signInForm, captcha: 'R7KQ2M', accepted: true }]);
      inOrder(t, 'language dialog dismissed, login opened, fields filled, cursor put in the captcha box, captcha typed, Sign In pressed', log,
        ['click language[English]', 'click header.login', 'input login.userid', 'input login.password', 'focus login.captcha',
          'input login.captcha', 'click login.submit', 'submit login']);
      t.same('Sign In pressed once, by the extension on Enter', pressed(log, 'login.submit'), ['script']);
      t.same('the person typed the captcha and did nothing else', byThePerson(log), ['input login.captcha']);
      const wait = elapsed(log, 'input login.password', 'focus login.captcha');
      t.check(`the cursor is in the box ${wait} ms after the password was filled in, ${elapsed(log, 'shown login.captcha', 'focus login.captcha')} ms`
        + ' after the captcha was drawn (the pop-up came a second later)', wait < 500);
    },
  },

  {
    name: 'login, wrong captcha then the right one: two sign-ins',
    site: { loginCaptcha: ['R7KQ2M', 'P3WX8D'] },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2N');
      // The refusal re-creates the image and the box.
      seesNote(t, 'after the refusal', await cursorInCaptcha(t, 'login.captcha', 2), 'login.captcha', LOGIN_RETRY_NOTE);
      t.same('after the refusal: one sign-in so far', submitted(await t.readLog(), 'login').length, 1);
      await typeAndEnter(t, 'P3WX8D');
      await signedIn(t);
      t.same('the note is gone once signed in', (await look(t)).note, null);
    },
    verify(t, log) {
      t.same('exactly two sign-ins: the refused one, then the one with the new captcha',
        submitted(log, 'login').map(({ captcha, accepted }) => ({ captcha, accepted })),
        [{ captcha: 'R7KQ2N', accepted: false }, { captcha: 'P3WX8D', accepted: true }]);
      inOrder(t, 'refusal, new captcha, cursor back in the box, second try, then the journey form', log,
        ['submit login', 'shown login.captcha', 'focus login.captcha', 'input login.captcha', 'click login.submit', 'submit login', 'input journey.origin']);
      t.same('Sign In pressed twice, by the extension on each Enter', pressed(log, 'login.submit'), ['script', 'script']);
      t.same('the person typed the two captchas and did nothing else', byThePerson(log), ['input login.captcha', 'input login.captcha']);
    },
  },

  {
    name: "login, captcha typed then a click on the site's own Sign In: one sign-in",
    site: { loginCaptcha: ['R7KQ2M'] },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await t.page.keyboard.type('R7KQ2M');
      await t.page.locator('app-login button[type="submit"]').click();
      await signedIn(t);
      t.same('the note is gone once signed in', (await look(t)).note, null);
    },
    verify(t, log) {
      t.same('exactly one sign-in, with the captcha as typed',
        submitted(log, 'login'), [{ ...signInForm, captcha: 'R7KQ2M', accepted: true }]);
      t.same('Sign In pressed once, by the person; the extension adds no press of its own', pressed(log, 'login.submit'), ['user']);
    },
  },

  {
    name: 'login, Enter in an empty captcha box: nothing is sent',
    site: { loginCaptcha: ['R7KQ2M'] },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await t.page.keyboard.press('Enter');
      await t.pause(700); // longer than a sign-in takes to be answered
      const log = await t.readLog();
      t.same('Enter in the empty box: no sign-in', submitted(log, 'login'), []);
      t.same('that Enter is left to the page, whose form is not sent while the box is empty; the extension presses nothing',
        pressed(log, 'login.submit'), ['user']);
      seesNote(t, 'after that Enter', await look(t), 'login.captcha', LOGIN_NOTE);
      await typeAndEnter(t, 'R7KQ2M');
      await signedIn(t);
    },
    verify(t, log) {
      t.same('exactly one sign-in in the end, once the captcha was typed',
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'R7KQ2M', accepted: true }], ['user', 'script']]);
    },
  },

  {
    name: 'login on a page with its own Enter handler, Enter pressed twice: one sign-in',
    site: { loginCaptcha: ['R7KQ2M'], pageEnterKey: 'keydown' },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.page.keyboard.press('Enter');
      await signedIn(t);
    },
    verify(t, log) {
      t.same("exactly one sign-in: the page's handler never got either Enter, and the second one was ignored",
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'R7KQ2M', accepted: true }], ['script']]);
    },
  },

  {
    name: 'login on a page that submits when Enter is released: one sign-in',
    site: { loginCaptcha: ['R7KQ2M'], pageEnterKey: 'keyup' },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await signedIn(t);
    },
    verify(t, log) {
      t.same("exactly one sign-in: the page's handler did not get the release of that Enter either",
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'R7KQ2M', accepted: true }], ['script']]);
    },
  },

  {
    name: "login, another captcha asked for with the site's own control: the cursor follows it",
    site: { loginCaptcha: ['R7KQ2M', 'P3WX8D'] },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await t.page.locator('app-login [data-rec="login.captcha.another"]').click();
      // Nothing was sent. The note says only what the extension can know: a new captcha is shown.
      seesNote(t, 'with the second captcha', await cursorInCaptcha(t, 'login.captcha', 2), 'login.captcha', LOGIN_RETRY_NOTE);
      await typeAndEnter(t, 'P3WX8D');
      await signedIn(t);
    },
    verify(t, log) {
      t.same('exactly one sign-in, with the second captcha, sent by the extension on Enter',
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'P3WX8D', accepted: true }], ['script']]);
      t.same('the person asked for another captcha and typed it', byThePerson(log), ['click login.captcha.another', 'input login.captcha']);
    },
  },

  {
    name: 'login answered after four seconds, Enter pressed again meanwhile: one sign-in',
    site: { loginCaptcha: ['R7KQ2M'], answerTime: 4000 },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.pause(3300); // the sign-in has not been answered yet
      await t.page.keyboard.press('Enter');
      await signedIn(t);
    },
    verify(t, log) {
      t.same('exactly one sign-in: the second Enter sent nothing, however long the answer took',
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'R7KQ2M', accepted: true }], ['script']]);
    },
  },

  {
    name: "login refused with the same captcha left in place: Enter stays ignored, the site's own Sign In still works",
    site: { loginCaptcha: ['R7KQ2M'], loginRejects: 1, captchaRedraw: 'none' },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.pause(3500); // the refusal was shown long ago, and nothing else on the page changed
      await t.page.keyboard.press('Enter');
      await t.pause(700); // longer than a sign-in takes to be answered
      t.same('Enter with no new captcha shown, however long after the first: still one sign-in', submitted(await t.readLog(), 'login').length, 1);
      await t.page.locator('app-login button[type="submit"]').click();
      await signedIn(t);
    },
    verify(t, log) {
      t.same("exactly two sign-ins: the extension's on the first Enter, then the person's with the site's own button",
        [submitted(log, 'login').map(({ captcha, accepted }) => ({ captcha, accepted })), pressed(log, 'login.submit')],
        [[{ captcha: 'R7KQ2M', accepted: false }, { captcha: 'R7KQ2M', accepted: true }], ['script', 'user']]);
    },
  },

  {
    name: 'login refused, the captcha kept and only its box replaced by an empty one: Enter works again',
    site: { loginCaptcha: ['R7KQ2M'], loginRejects: 1, captchaRedraw: 'box' },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.until('the cursor to be put in the new box', (log) => of(log, 'focus', 'login.captcha').length > 1);
      // No new captcha was drawn, so the note keeps its first wording.
      seesNote(t, 'with the new box', await look(t), 'login.captcha', LOGIN_NOTE);
      await typeAndEnter(t, 'R7KQ2M');
      await signedIn(t);
    },
    verify(t, log) {
      t.same('exactly two sign-ins, each sent by the extension on Enter',
        [submitted(log, 'login').map(({ captcha, accepted }) => ({ captcha, accepted })), pressed(log, 'login.submit')],
        [[{ captcha: 'R7KQ2M', accepted: false }, { captcha: 'R7KQ2M', accepted: true }], ['script', 'script']]);
    },
  },

  {
    name: 'Auto Booking switched off while the login captcha is waited for: the note goes and the page is left to the person',
    site: { loginCaptcha: ['R7KQ2M', 'P3WX8D'] },
    settings: settings(),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await t.switchOff();
      await t.until('the note to be taken away', async () => (await look(t)).note === null, 5000);
      // Nothing follows the captcha any more: another one does not bring the cursor to its box.
      await t.page.locator('app-login [data-rec="login.captcha.another"]').click();
      await t.until('the second captcha to be drawn', (log) => of(log, 'shown', 'login.captcha').length > 1);
      await t.pause(500);
      t.same('the cursor is not put in the box of a captcha drawn after the switch', (await look(t)).cursor, null);
      // Enter is the page's own business again: the person clicks the box, types and presses it.
      await t.page.locator('app-login #captcha').click();
      await typeAndEnter(t, 'P3WX8D');
      await t.until('the sign-in', (log) => of(log, 'submit', 'login').length > 0);
      await t.pause(1500); // long enough for the journey form to be started on, if the run went on
    },
    verify(t, log) {
      t.same('exactly one sign-in, sent by the page for the person on Enter; the extension presses nothing',
        [submitted(log, 'login'), pressed(log, 'login.submit')],
        [[{ ...signInForm, captcha: 'P3WX8D', accepted: true }], ['user']]);
      t.same('the run does not go on to the journey form', of(log, 'input', 'journey.origin'), []);
    },
  },

  {
    name: 'login without a captcha: signs in by itself',
    // The form keeps a captcha box that is never painted, and no language dialog comes up.
    site: { loginCaptchaUnpainted: true, languagePopup: false },
    settings: settings(),
    async drive(t) {
      await t.until('the sign-in', (log) => of(log, 'submit', 'login').length > 0);
      t.same('no note is shown', (await look(t)).note, null);
      await signedIn(t);
    },
    verify(t, log) {
      t.same('exactly one sign-in, carrying the user id and the password and no captcha',
        submitted(log, 'login'), [{ ...signInForm, captcha: '', accepted: true }]);
      t.same('the unpainted captcha box is left alone: nothing typed, no cursor put in it',
        [...of(log, 'input', 'login.captcha'), ...of(log, 'focus', 'login.captcha')], []);
      t.same('all of it done by the extension', byThePerson(log), []);
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
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.until('the passenger form to be continued', (log) => of(log, 'submit', 'passengers').length > 0, 45000);
    },
    verify(t, log) {
      t.same('each selected name picked from the suggestions, one row each, in their order',
        clicked(log, 'passenger[').filter((key) => key.includes('.option[')),
        ['passenger[0].name.option[Ravi Example]', 'passenger[1].name.option[Asha Example]']);
      t.same('rows continued with the age and gender the site filled in, berth and food left alone',
        (submitted(log, 'passengers')[0] || {}).passengers, [
          { name: 'Ravi Example', age: '61', gender: 'M', berth: '', food: '' },
          { name: 'Asha Example', age: '34', gender: 'F', berth: '', food: '' },
        ]);
      t.same('the person typed the login captcha and did nothing else', byThePerson(log), ['input login.captcha']);
    },
  },

  // The second name is not in the site's list. The extension gives it twenty
  // seconds, says so in a pop-up and waits for that row to be filled in. The
  // person takes the row off the page instead.
  {
    name: 'saved passenger list, a name it never offers and that row removed by hand: the names after it are still picked',
    site: {
      loginCaptcha: ['R7KQ2M'],
      savedPassengers: [
        { name: 'Asha Example', age: 34, gender: 'F' },
        { name: 'Ravi Example', age: 61, gender: 'M' },
      ],
    },
    settings: settings({
      quotaType: 'GENERAL',
      masterData: true,
      passengerNames: [
        { id: 1, name: 'Ravi Example', isSelected: true },
        { id: 2, name: 'Nobody Example', isSelected: true },
        { id: 3, name: 'Asha Example', isSelected: true },
      ],
    }),
    // The one pop-up this run is expected to raise.
    dialogs: [{
      type: 'alert',
      message: 'Passenger "Nobody Example" was not found in your IRCTC master list.'
        + '\nChoose passenger 2 yourself. The automation carries on once that row is filled.',
    }],
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.until('the pop-up about the name that is not offered', () => t.dialogs.length > 0, 60000);
      await t.page.locator('app-passenger').nth(1).locator('a.fa-remove').click();
      await t.until('the passenger form to be continued', (log) => of(log, 'submit', 'passengers').length > 0);
    },
    verify(t, log) {
      t.same('the two names the list offers are picked, each in a row of its own',
        clicked(log, 'passenger[').filter((key) => key.includes('.option[')),
        ['passenger[0].name.option[Ravi Example]', 'passenger[1].name.option[Asha Example]']);
      t.same('the form is continued once, with those two rows',
        submitted(log, 'passengers').map((form) => form.passengers), [[
          { name: 'Ravi Example', age: '61', gender: 'M', berth: '', food: '' },
          { name: 'Asha Example', age: '34', gender: 'F', berth: '', food: '' },
        ]]);
      t.same('the person typed the login captcha, removed that row and did nothing else',
        byThePerson(log), ['input login.captcha', 'click passenger[1].remove']);
    },
  },

  // Every answer takes four seconds here, and on the review page Enter is
  // pressed again while Continue is still awaited.
  booking('whole flow to the payment page, review captcha typed then Enter twice, autoPay off: one Continue, Pay is not pressed', {
    site: { ...twoCaptchas, answerTime: 4000 },
    expected: upiJourney,
  }),

  // The seat status is shown two seconds after the review page. The refusal
  // changes it to a waiting-list one, changes the captcha image where it is,
  // takes the cursor out of the box and then puts a new box in its place.
  booking('whole flow with autoPay on, seat status shown late, review captcha wrong then right: Pay is pressed exactly once', {
    site: {
      loginCaptcha: ['R7KQ2M'], reviewCaptcha: ['H4TXW9', 'K8PLM3'], captchaRedraw: 'src', seatsAfter: 2000, seatsWhenRefused: 'WL 7',
    },
    overrides: { autoPay: true },
    expected: upiJourney,
    typedOnReview: ['H4TXW8', 'K8PLM3'],
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

  // The configured train is not in the results. The person picks a class and
  // a date on the train that is, and presses Book Now, while the extension is
  // still giving its own train time to show up in the list.
  {
    name: 'configured train not in the results, another train booked by hand meanwhile: no pop-up over the passenger page',
    site: { loginCaptcha: ['R7KQ2M'], trains: [{ number: '99120', name: 'STANDIN MAIL', classes: ['SL', '3A'] }] },
    settings: settings({ quotaType: 'GENERAL' }),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await t.until('the train list', (log) => views(log).includes('trains'), 45000);
      await t.pause(1500); // the person reads the list first; the extension looks for its train for 5.5 s
      for (const part of ['class[3A]', 'date[Fri, 07 Mar]', 'book']) {
        await t.page.locator(`[data-rec="train[99120].${part}"]`).click();
      }
      await t.until('the passenger form to be continued', (log) => of(log, 'submit', 'passengers').length > 0);
    },
    verify(t, log) {
      t.same('Book Now pressed once, for the train, class and date the person chose',
        submitted(log, 'book'), [{ train: '99120', travelClass: '3A', date: 'Fri, 07 Mar' }]);
      t.same('the person typed the login captcha and booked that train; the extension clicked nothing in the train list',
        [byThePerson(log), clicked(log, 'train[').length],
        [['input login.captcha', 'click train[99120].class[3A]', 'click train[99120].date[Fri, 07 Mar]', 'click train[99120].book'], 3]);
      const wait = elapsed(log, 'view passengers', 'click passenger[0].remove');
      t.check(`the extension starts on the passenger page ${wait} ms after it appeared (it used to go on looking for its train for the rest of 5.5 s)`, wait < 2500);
      t.same('the passenger form is continued once, for the two selected passengers',
        submitted(log, 'passengers').map((form) => form.passengers.map((passenger) => passenger.name)), [['Asha Example', 'Ravi Example']]);
    },
  },

  {
    name: 'review page left with Back while the captcha is waited for: the note is taken away',
    site: twoCaptchas,
    settings: settings({ quotaType: 'GENERAL' }),
    async drive(t) {
      await cursorInCaptcha(t, 'login.captcha');
      await typeAndEnter(t, 'R7KQ2M');
      await cursorInCaptcha(t, 'review.captcha');
      await t.page.locator('app-review-booking [data-rec="review.back"]').click();
      await t.until('the passenger page to come back', (log) => views(log).filter((view) => view === 'passengers').length === 2);
      t.same('no note is left on the page', (await look(t)).note, null);
    },
    verify(t, log) {
      t.same('nothing was continued on the review page', [submitted(log, 'review'), pressed(log, 'review.continue')], [[], []]);
    },
  },

  // autoSolveCaptcha takes the extension's other two branches, which this
  // harness only checks for being left as they were. The reader they call has
  // no service to reach from the test browser, so it gives them nothing: they
  // put that in the box and press the button, and the browser does not send
  // the form with the box empty. The person then types in the page, as before.
  {
    name: 'whole flow with autoSolveCaptcha on: no note, no prompt, and the extension does not move the cursor',
    site: twoCaptchas,
    settings: settings({ quotaType: 'GENERAL', autoSolveCaptcha: true, autoSubmitCaptcha: true }),
    // The reader's attempts to send each captcha image to its service. They fail at name resolution.
    outsideRequests: Array(2).fill('POST https://api.ocr.space/parse/image'),
    async drive(t) {
      for (const [page, box, button, text] of [
        ['app-login', 'login.captcha', 'login.submit', 'R7KQ2M'],
        ['app-review-booking', 'review.captcha', 'review.continue', 'H4TXW9'],
      ]) {
        await t.until(`the extension to press ${button}`, (log) => pressed(log, button).includes('script'), 45000);
        t.same(`${box}: no note`, (await look(t)).note, null);
        t.same(`${box}: nothing was sent with the box empty`, submitted(await t.readLog(), box.split('.')[0]), []);
        await t.page.locator(`${page} #captcha`).click();
        await typeAndEnter(t, text);
      }
      await t.until('a payment provider to be picked', (log) => clicked(log, 'pay.provider[').length > 0, 45000);
    },
    verify(t, log) {
      t.same('pages visited, in order', views(log), ['home', 'trains', 'passengers', 'review', 'payment']);
      t.same('sign-in: the extension fills the box with what the reader gave (nothing) and presses Sign In; then the person types and presses Enter',
        actions(log, ['login.captcha', 'login.submit']),
        ['click login.captcha script', 'input login.captcha script', 'click login.submit script',
          'click login.captcha user', 'input login.captcha user', 'click login.submit user']);
      t.same('review: the same, with Continue',
        actions(log, ['review.captcha', 'review.continue']),
        ['click review.captcha script', 'input review.captcha script', 'click review.continue script',
          'click review.captcha user', 'input review.captcha user', 'click review.continue user']);
      t.same('one sign-in and one review step, with what the person typed',
        [submitted(log, 'login'), submitted(log, 'review')],
        [[{ ...signInForm, captcha: 'R7KQ2M', accepted: true }], [{ captcha: 'H4TXW9', accepted: true }]]);
      // The browser points at the box it found empty, which puts the cursor there.
      t.check('the extension does not put the cursor in either box: it gets there only after the button was pressed on an empty box',
        firstAt(log, 'focus login.captcha') > firstAt(log, 'click login.submit')
          && firstAt(log, 'focus review.captcha') > firstAt(log, 'click review.continue'));
      const wait = elapsed(log, 'input login.password', 'click login.captcha');
      t.check(`this path keeps its one-second scroll wait: the box is filled ${wait} ms after the password`, wait >= 1000);
      t.same('payment method and provider picked as configured',
        [clicked(log, 'pay.method['), clicked(log, 'pay.provider[')], [['pay.method[BHIM/ UPI/ USSD]'], [`pay.provider[${UPI_PROVIDER}]`]]);
    },
  },
];
