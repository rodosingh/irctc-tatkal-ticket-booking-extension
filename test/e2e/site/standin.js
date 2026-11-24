'use strict';

// Stand-in for the booking site, used only by test/e2e. It is derived from the
// selectors and texts in chrome-extension/src/scripts/user-script.js: every
// element below exists because that script looks for it, apart from two
// controls for the person (another captcha, Back on the review page). What
// this assumes about the real pages is listed in ../README.md.

(function () {
  // ---- per-scenario configuration: ?standin=<JSON> ----
  const cfg = Object.assign({
    languagePopup: true, // show the language dialog over the home page
    loginCaptcha: [], // texts shown in turn, one per sign-in attempt; [] = no captcha
    loginCaptchaUnpainted: false, // with no captcha, still leave an unrendered box in the form
    loginRejects: 0, // refuse the first N sign-ins whatever was typed
    reviewCaptcha: [], // the same three for the review page
    reviewCaptchaUnpainted: false,
    reviewRejects: 0,
    // How the next captcha is drawn: 'replace' re-creates the image and the
    // box together; 'src' changes the image where it is, takes the cursor out
    // of the box and a moment later puts an empty box in its place; 'box'
    // keeps a refused captcha and only puts an empty box in its place; 'none'
    // leaves a refused captcha as it is.
    captchaRedraw: 'replace',
    pageEnterKey: null, // 'keydown' or 'keyup': forms with a captcha submit on Enter with a handler of their own
    answerTime: 500, // ms that sign-in, the review step and Pay take to be answered
    seatsAfter: 0, // ms after the review page appears that its seat status is shown; 0 = with the page
    seatsWhenRefused: null, // the waiting-list status the review page shows once a captcha was refused
    clock: null, // 'HH:MM:SS' the header clock starts at; null = this machine's time
    trains: [
      { number: '99120', name: 'STANDIN MAIL', classes: ['SL', '3A'] },
      { number: '99123', name: 'STANDIN EXPRESS', classes: ['SL', '3A', '2A'] },
    ],
    refreshesBeforeBookable: 0, // Book Now stays disabled for the first N availability enquiries
    availabilityErrors: [], // texts that answer the first availability enquiries in turn, in place of availability
    enquiryTime: 0, // ms an availability enquiry takes, the loading overlay up meanwhile; 0 = a moment, no overlay
    autoUpgradationChecked: false, // how the two preference boxes are rendered
    confirmBerthsChecked: false,
    savedPassengers: [], // [{ name, age, gender }] offered by the passenger name box
  }, JSON.parse(new URLSearchParams(location.search).get('standin') || '{}'));

  const STATIONS = ['NORTHGATE - NGT', 'NORTHGATE CANTT - NGTC', 'SOUTHPORT JN - SPT', 'EASTFIELD - EFD'];
  const QUOTAS = ['GENERAL', 'LADIES', 'TATKAL', 'PREMIUM TATKAL'];
  const CLASS_NAMES = {
    SL: 'Sleeper (SL)', '3A': 'AC 3 Tier (3A)', '2A': 'AC 2 Tier (2A)', '1A': 'AC First Class (1A)',
    '3E': 'AC 3 Economy (3E)', EC: 'Exec. Chair Car (EC)', CC: 'AC Chair car (CC)', '2S': 'Second Sitting (2S)',
  };
  const SEATS = 'AVAILABLE-0042';
  // Method tiles and the providers each one lists, with others around the two
  // the options page can store so that picking by position would go wrong.
  const PAYMENT_METHODS = [
    ['Multiple Payment Service', ['Stand-in multi pay']],
    ['BHIM/ UPI/ USSD', ['Stand-in UPI collect', 'Pay using BHIM (Powered by PAYTM) also accepts UPI']],
    ['Net Banking', ['Stand-in Bank']],
    ['E-Wallet', ['IRCTC eWallet']],
  ];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The real site fetches and renders in steps and the extension's waits depend
  // on that, so a click here shows its result a moment later, not in the same
  // tick. The few results the extension reads without waiting stay immediate.
  const later = (fn) => setTimeout(fn, 150);
  // Sign-in, the review step and Pay take as long as a slow request would, and
  // their buttons stay on the page meanwhile, so a second press gets recorded.
  const answered = (fn) => setTimeout(fn, cfg.answerTime);
  const two = (n) => String(n).padStart(2, '0');

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      el.setAttribute(name, value === true ? '' : value);
    }
    el.append(...children.flat().filter((child) => child != null));
    return el;
  }

  // ---- the page clock ----
  let clockOffset = 0;
  let shownClock = '';
  // The clock and the seat status change where they are, as a bound text
  // does: no node is added or removed.
  const clockText = document.createTextNode('');
  const clockEl = h('strong', null, clockText);
  function setClock(hhmmss) {
    const [hours, minutes, seconds] = hhmmss.split(':').map(Number);
    clockOffset = new Date().setHours(hours, minutes, seconds, 0) - Date.now();
    tick();
  }
  function tick() {
    const now = new Date(Date.now() + clockOffset);
    shownClock = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    clockText.data = `${two(now.getDate())}-${MONTHS[now.getMonth()]}-${now.getFullYear()} [${shownClock}]`;
  }

  // ---- the record of what was done to the page ----
  const log = [];
  const loadedAt = performance.now();
  function record(type, key, details) {
    log.push(Object.assign({ n: log.length + 1, ms: Math.round(performance.now() - loadedAt), clock: shownClock, type, key }, details));
  }
  // click() and dispatchEvent() from a script give untrusted events; real mouse
  // and keyboard input gives trusted ones.
  const by = (event) => (event.isTrusted ? 'user' : 'script');

  // Like a framework-bound form, the page learns what a field holds only from
  // the input or change event fired on it, never by reading the DOM afterwards.
  const known = new WeakMap();
  const valueOf = (el) => (el && known.has(el) ? known.get(el) : '');

  const passengerRows = () => Array.from(document.querySelectorAll('app-passenger'));
  function keyOf(target) {
    const el = target.closest('[data-rec]');
    if (!el) return null;
    const row = el.closest('app-passenger');
    return row ? `passenger[${passengerRows().indexOf(row)}].${el.dataset.rec}` : el.dataset.rec;
  }

  // Capturing listeners on the document also see events that do not bubble.
  document.addEventListener('click', (event) => {
    const key = keyOf(event.target);
    if (!key) return;
    const el = event.target.closest('[data-rec]');
    const toggles = el.type === 'checkbox' || el.type === 'radio';
    record('click', key, toggles ? { by: by(event), checked: el.checked } : { by: by(event) });
  }, true);
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (!el.matches('input:not([type="checkbox"]):not([type="radio"])')) return;
    known.set(el, el.value);
    const key = keyOf(el);
    const last = log[log.length - 1];
    // One record per run of typing in a field, holding the latest value.
    if (last && last.type === 'input' && last.key === key && last.by === by(event)) last.value = el.value;
    else record('input', key, { value: el.value, by: by(event) });
  }, true);
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!el.matches('select')) return;
    known.set(el, el.value);
    record('change', keyOf(el), { value: el.value, by: by(event) });
  }, true);
  // Where the cursor is matters for a captcha box only.
  document.addEventListener('focus', (event) => {
    if (event.target.matches('app-captcha #captcha')) record('focus', keyOf(event.target));
  }, true);

  // ---- shared pieces ----
  const root = document.querySelector('app-root');
  const main = h('div');
  // The overlay the site puts up while it waits for an answer.
  const loading = h('div', { class: 'my-loading', hidden: true }, 'Please Wait...');
  function show(view, ...nodes) {
    record('view', view);
    main.replaceChildren(...nodes);
  }

  const closeSuggestions = () => document.querySelectorAll('.ui-autocomplete-items').forEach((list) => list.remove());
  // Typing in `input` lists the matches under it; picking one closes the list.
  function suggest(input, find, pick) {
    input.addEventListener('input', () => later(() => {
      closeSuggestions();
      const typed = input.value.trim().toLowerCase();
      const matches = typed ? find(typed) : [];
      if (!matches.length) return;
      input.after(h('ul', { class: 'ui-autocomplete-items' }, matches.map((match) => {
        const item = h('li', { 'data-rec': `${input.dataset.rec}.option[${match}]` }, match);
        item.addEventListener('click', () => {
          pick(match);
          closeSuggestions();
        });
        return item;
      })));
    }));
  }

  function captchaImage(text) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="50"><rect width="100%" height="100%" fill="#e7ecf5"/>`
      + `<text x="14" y="34" font-family="monospace" font-size="26" letter-spacing="6">${text}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  // A captcha box and its checking. Each new captcha shows the next text.
  function captchaStep(rec, texts, unpainted, rejects) {
    let attempts = 0;
    let drawn = 0;
    const slot = h('div');
    const shown = () => (texts.length ? texts[Math.min(drawn, texts.length - 1)] : null);
    const box = () => slot.querySelector('#captcha');
    // A box that is shown must be filled in: while it is empty the browser
    // does not send the form.
    const emptyBox = () => h('input', {
      id: 'captcha', formcontrolname: 'captcha', autocomplete: 'off', required: texts.length > 0, 'data-rec': rec,
    });
    const render = () => {
      slot.replaceChildren();
      if (!texts.length && !unpainted) return;
      // The site's own control for another captcha. The extension never looks for it.
      const another = h('a', { 'data-rec': `${rec}.another` }, 'Another captcha');
      another.addEventListener('click', () => next(cfg.captchaRedraw === 'src' ? 'src' : 'replace'));
      slot.append(h('app-captcha', { class: texts.length ? null : 'unpainted' },
        h('img', { class: 'captcha-img', alt: 'captcha', src: captchaImage(shown() || 'UNSEEN') }), emptyBox(), another));
      if (texts.length) record('shown', rec);
    };
    const next = (how) => {
      if (how === 'none') return;
      if (how === 'box') return box().replaceWith(emptyBox());
      drawn += 1;
      if (how === 'replace') return render();
      slot.querySelector('img').src = captchaImage(shown());
      box().blur();
      later(() => {
        box().replaceWith(emptyBox());
        record('shown', rec);
      });
    };
    render();
    return {
      slot,
      refused: () => next(cfg.captchaRedraw),
      typed: () => valueOf(box()),
      passes() {
        const ok = attempts >= rejects && (shown() === null || this.typed() === shown());
        attempts += 1;
        return ok;
      },
    };
  }
  // A page may submit on Enter with a handler of its own, in place of the
  // browser's submission: on keydown, or on keyup.
  function ownEnterHandling(form) {
    if (!cfg.pageEnterKey) return;
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (cfg.pageEnterKey === 'keydown') form.requestSubmit();
    });
    form.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' && cfg.pageEnterKey === 'keyup') form.requestSubmit();
    });
  }

  // ---- header, language dialog, sign-in ----
  const loginLink = h('a', { class: 'loginText', 'data-rec': 'header.login' }, 'LOGIN');
  loginLink.addEventListener('click', () => later(() => {
    if (!document.querySelector('app-login')) root.append(loginForm());
  }));
  const header = h('app-header', null, h('div', { class: 'h_head1' }, loginLink, h('span', null, clockEl)));

  function languageDialog() {
    const dialog = h('p-dialog', null, h('p', null, 'Please select your preferred language'),
      ['Hindi', 'English'].map((name) => h('button', {
        type: 'button', 'aria-label': `Please select your preferred language ${name}`, 'data-rec': `language[${name}]`,
      }, name)));
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('button')) later(() => dialog.remove());
    });
    return dialog;
  }

  function loginForm() {
    const userid = h('input', { formcontrolname: 'userid', placeholder: 'User Name', autocomplete: 'off', 'data-rec': 'login.userid' });
    const password = h('input', { formcontrolname: 'password', type: 'password', placeholder: 'Password', 'data-rec': 'login.password' });
    const captcha = captchaStep('login.captcha', cfg.loginCaptcha, cfg.loginCaptchaUnpainted, cfg.loginRejects);
    const error = h('p', { class: 'error' });
    const form = h('form', null, userid, password, captcha.slot, error,
      h('button', { type: 'submit', 'data-rec': 'login.submit' }, 'SIGN IN'));
    const modal = h('app-login', null, h('h3', null, 'Sign in'), form);

    ownEnterHandling(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = { userid: valueOf(userid), password: valueOf(password), captcha: captcha.typed() };
      const accepted = captcha.passes() && Boolean(data.userid && data.password);
      record('submit', 'login', { data, accepted });
      answered(() => {
        if (accepted) {
          modal.remove();
          loginLink.replaceWith(h('span', null, `Welcome ${data.userid}`));
        } else {
          error.textContent = 'Sign in was refused. Enter the details shown and try again.';
          captcha.refused();
        }
      });
    });
    return modal;
  }

  // ---- home: journey search ----
  function showHome() {
    const station = (id, rec) => {
      const input = h('input', { autocomplete: 'off', 'data-rec': rec });
      suggest(input, (typed) => STATIONS.filter((name) => name.toLowerCase().includes(typed)), (name) => {
        input.value = name;
        known.set(input, name);
      });
      return [input, h('p-autocomplete', { id }, input)];
    };
    const [origin, originField] = station('origin', 'journey.origin');
    const [destination, destinationField] = station('destination', 'journey.destination');
    const date = h('input', { autocomplete: 'off', placeholder: 'DD/MM/YYYY', 'data-rec': 'journey.date' });

    let quota = QUOTAS[0];
    let panel = null;
    const quotaLabel = h('span', null, quota);
    const quotaBox = h('div', { class: 'ui-dropdown', 'data-rec': 'journey.quota' }, quotaLabel);
    const closePanel = () => {
      if (panel) panel.remove();
      panel = null;
    };
    quotaBox.addEventListener('click', (event) => {
      if (event.target.closest('p-dropdownitem')) return;
      if (panel) return closePanel();
      later(() => {
        closePanel();
        panel = h('ul', { class: 'ui-dropdown-items' }, QUOTAS.map((name) => {
          const item = h('p-dropdownitem', null, h('li', { 'data-rec': `journey.quota.option[${name}]` }, h('span', null, name)));
          item.addEventListener('click', () => {
            quota = name;
            quotaLabel.textContent = name;
            closePanel();
          });
          return item;
        }));
        quotaBox.append(panel);
      });
    });

    const form = h('form', null,
      h('div', null, 'From ', originField), h('div', null, 'To ', destinationField),
      h('div', null, 'Date ', h('p-calendar', { id: 'jDate' }, date)),
      h('div', null, 'Quota ', h('p-dropdown', { id: 'journeyQuota' }, quotaBox)),
      h('button', { type: 'submit', class: 'search_btn train_Search', 'data-rec': 'journey.search' }, 'Search'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const journey = { origin: valueOf(origin), destination: valueOf(destination), date: valueOf(date), quota };
      record('submit', 'search', { data: journey });
      later(() => showTrains(journey));
    });
    show('home', h('app-jp-input', null, form));
  }

  // ---- train list ----
  function showTrains(journey) {
    const [day, month, year] = journey.date.split('/').map(Number);
    const dates = [0, 1, 2].map((offset) => {
      const date = new Date(year, month - 1, day + offset);
      return `${DAYS[date.getDay()]}, ${two(date.getDate())} ${MONTHS[date.getMonth()]}`;
    });
    const className = (code) => CLASS_NAMES[code] || code;
    let enquiries = 0;
    let pending = 0; // enquiries asked for and not yet answered

    const card = (train) => {
      const rec = `train[${train.number}]`;
      const tabs = h('div');
      const cells = h('div', { class: 'cells' });
      const book = h('button', { type: 'button', class: 'btnDefault train_Search disable-book', 'data-rec': `${rec}.book` }, 'Book Now');
      let choice = null;

      // Choosing a class swaps the class cells for a tab per class and one
      // availability cell per date; clicking the selected tab asks again.
      // With `enquiryTime` an enquiry takes that long and the loading overlay
      // is up meanwhile. One asked for while another is pending is recorded as
      // such: on the real site that doubled request is what signs people out.
      const ask = (code) => {
        if (!cfg.enquiryTime) return later(() => enquire(code));
        record('enquiry', rec, { pending: pending > 0 });
        pending += 1;
        loading.hidden = false;
        setTimeout(() => {
          pending -= 1;
          loading.hidden = pending === 0;
          enquire(code);
        }, cfg.enquiryTime);
      };
      const enquire = (code) => {
        enquiries += 1;
        const error = cfg.availabilityErrors[enquiries - 1];
        const bookable = enquiries > cfg.refreshesBeforeBookable;
        choice = null;
        book.classList.add('disable-book');
        tabs.replaceChildren(h('p-tabmenu', null, h('ul', null, train.classes.map((other) => {
          const tab = h('div', { 'data-rec': `${rec}.tab[${other}]` }, className(other));
          tab.addEventListener('click', () => ask(other));
          return h('li', { role: 'tab', 'aria-selected': String(other === code), 'aria-expanded': String(other === code) }, h('a', null, tab));
        }))));
        // A refused enquiry shows its reason where the dates would be, and in
        // a toast that goes away by itself. No availability is added.
        if (error) {
          cells.replaceChildren(h('div', { class: 'col-xs-12' }, error));
          const toast = h('p-toast', null, h('div', { class: 'ui-toast-message' },
            h('div', { class: 'ui-toast-summary' }, 'Error!'), h('div', { class: 'ui-toast-detail' }, error)));
          root.append(toast);
          setTimeout(() => toast.remove(), 3000);
          return;
        }
        const dateCells = dates.map((date) => {
          const cell = h('div', { class: 'pre-avl', 'data-rec': `${rec}.date[${date}]` }, h('div', null, h('strong', null, date)));
          cell.addEventListener('click', () => {
            if (!bookable) return;
            choice = { train: train.number, travelClass: code, date };
            book.classList.remove('disable-book');
          });
          return cell;
        });
        cells.replaceChildren(...dateCells);
        // Each status goes in as its own node after its cell is already on the
        // page: the extension counts exactly these insertions.
        for (const cell of dateCells) {
          cell.append(h('div', { class: `link ng-star-inserted${bookable ? ' AVAILABLE' : ''}` },
            h('strong', null, bookable ? SEATS : 'Booking not open yet')));
        }
      };

      cells.append(...train.classes.map((code) => {
        const cell = h('div', { class: 'pre-avl', 'data-rec': `${rec}.class[${code}]` },
          h('div', null, h('strong', null, className(code))), h('div', null, 'Refresh'));
        cell.addEventListener('click', () => ask(code));
        return cell;
      }));
      book.addEventListener('click', () => {
        if (book.classList.contains('disable-book')) return;
        record('submit', 'book', { data: choice });
        later(showPassengers);
      });
      return h('app-train-avl-enq', null,
        h('div', { class: 'train-heading' }, h('strong', null, `${train.name} (${train.number})`)), tabs, cells, book);
    };

    show('trains', h('app-train-list', null, cfg.trains.map(card)));
  }

  // ---- passenger details ----
  function passengerRow() {
    const select = (control, rec, options) => h('select', { formcontrolname: control, 'data-rec': rec },
      options.map(([value, label]) => h('option', { value }, label)));
    const name = h('input', { placeholder: 'Passenger Name', autocomplete: 'off', 'data-rec': 'name' });
    const age = h('input', { formcontrolname: 'passengerAge', placeholder: 'Age', autocomplete: 'off', 'data-rec': 'age' });
    const gender = select('passengerGender', 'gender', [['', 'Gender'], ['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']]);
    const berth = select('passengerBerthChoice', 'berth',
      [['', 'No Preference'], ['LB', 'Lower'], ['MB', 'Middle'], ['UB', 'Upper'], ['SL', 'Side Lower'], ['SU', 'Side Upper']]);
    const food = select('passengerFoodChoice', 'food',
      [['', '-'], ['V', 'Veg'], ['N', 'Non Veg'], ['J', 'Jain Meal'], ['F', 'Veg (Diabetic)'], ['G', 'Non Veg (Diabetic)'], ['D', 'No Food']]);
    const remove = h('a', { class: 'fa fa-remove', title: 'Remove', 'data-rec': 'remove' }, 'x');
    const row = h('app-passenger', null, h('p-autocomplete', null, name), age, gender, berth, food, remove);

    remove.addEventListener('click', () => row.remove());
    // Picking a saved passenger fills the row, as the site's master list does.
    suggest(name,
      (typed) => cfg.savedPassengers.map((saved) => saved.name).filter((saved) => saved.toLowerCase().includes(typed)),
      (picked) => {
        const saved = cfg.savedPassengers.find((passenger) => passenger.name === picked);
        for (const [field, value] of [[name, saved.name], [age, String(saved.age)], [gender, saved.gender]]) {
          field.value = value;
          known.set(field, value);
        }
      });
    row.read = () => ({ name: valueOf(name), age: valueOf(age), gender: valueOf(gender), berth: valueOf(berth), food: valueOf(food) });
    return row;
  }

  function showPassengers() {
    const rows = h('div', null, passengerRow());
    const add = h('a', { 'data-rec': 'passenger.add' }, h('span', { class: 'prenext' }, '+ Add Passenger'));
    add.addEventListener('click', () => rows.append(passengerRow()));

    const mobile = h('input', { id: 'mobileNumber', formcontrolname: 'mobileNumber', autocomplete: 'off', 'data-rec': 'mobile' });
    const autoUpgradation = h('input', { type: 'checkbox', id: 'autoUpgradation', checked: cfg.autoUpgradationChecked, 'data-rec': 'autoUpgradation' });
    const confirmberths = h('input', { type: 'checkbox', id: 'confirmberths', checked: cfg.confirmBerthsChecked, 'data-rec': 'confirmberths' });
    const radios = (name, rec, choices, wrap) => choices.map(([value, text]) => {
      const input = h('input', { type: 'radio', name, value, 'data-rec': `${rec}[${value}]` });
      return h('label', null, wrap ? h(wrap, { name }, input) : input, ` ${text}`);
    });
    const picked = (name) => {
      const input = page.querySelector(`input[name="${name}"]:checked`);
      return input ? input.value : null;
    };
    const proceed = h('button', { type: 'button', class: 'btnDefault train_Search', 'data-rec': 'passenger.continue' }, 'Continue');
    proceed.addEventListener('click', () => {
      record('submit', 'passengers', {
        data: {
          passengers: Array.from(rows.children).map((row) => row.read()),
          mobile: valueOf(mobile),
          autoUpgradation: autoUpgradation.checked,
          confirmberths: confirmberths.checked,
          insurance: picked('travelInsuranceOpted-0'),
          paymentType: picked('paymentType'),
        },
      });
      later(showReview);
    });

    const page = h('app-passenger-input', null,
      h('p-panel', null, rows, add),
      h('div', null, 'Mobile number ', mobile),
      h('label', null, autoUpgradation, ' Consider for Auto Upgradation.'),
      h('label', null, confirmberths, ' Book only if confirm berths are allotted.'),
      h('h4', null, 'Travel insurance'),
      radios('travelInsuranceOpted-0', 'insurance',
        [['yes', 'Yes, and I accept the terms & conditions'], ['no', "No, I don't want travel insurance"]]),
      h('h4', null, 'Payment mode'),
      radios('paymentType', 'paymentType', [
        ['cards', 'Pay through Credit & Debit Cards / Net Banking / Wallets / EMI / Rewards and Others'],
        ['upi', 'Pay through BHIM/UPI'],
      ], 'p-radiobutton'),
      proceed);
    show('passengers', page);
  }

  // ---- review ----
  function showReview() {
    const captcha = captchaStep('review.captcha', cfg.reviewCaptcha, cfg.reviewCaptchaUnpainted, cfg.reviewRejects);
    const error = h('p', { class: 'error' });
    // For the person who decides not to go on. The extension never looks for it.
    const back = h('button', { type: 'button', 'data-rec': 'review.back' }, 'Back');
    back.addEventListener('click', () => later(showPassengers));
    const form = h('form', null, captcha.slot, error,
      h('button', { type: 'submit', class: 'btnDefault train_Search', 'data-rec': 'review.continue' }, 'Continue'), back);
    ownEnterHandling(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = { captcha: captcha.typed() };
      const accepted = captcha.passes();
      record('submit', 'review', { data, accepted });
      answered(() => {
        if (accepted) return showPayment();
        error.textContent = 'That was refused. Enter the text shown and try again.';
        if (cfg.seatsWhenRefused) showSeats('WL', cfg.seatsWhenRefused);
        captcha.refused();
      });
    });
    const seatsText = document.createTextNode('');
    const seats = h('span', null, seatsText);
    const showSeats = (kind, text) => {
      seats.className = kind;
      seatsText.data = text;
      record('shown', 'review.seats', { value: text });
    };
    // The summary is tall enough to leave the captcha below the fold.
    show('review', h('app-review-booking', null,
      h('app-train-header', null, h('span', null, 'Seats: '), seats),
      h('div', { class: 'summary' }, 'Journey and fare summary'), form));
    if (cfg.seatsAfter) setTimeout(showSeats, cfg.seatsAfter, 'AVAILABLE', SEATS);
    else showSeats('AVAILABLE', SEATS);
  }

  // ---- payment ----
  function showPayment() {
    const chosen = { method: null, provider: null };
    const methods = h('div', { id: 'pay-type' });
    const providers = h('div', { id: 'bank-type' });
    const pay = h('button', { type: 'button', class: 'btn btn-primary ng-star-inserted', 'data-rec': 'pay.button' }, 'Pay & Book');
    const select = (el) => {
      for (const sibling of el.parentNode.children) sibling.classList.toggle('selected', sibling === el);
    };

    pay.addEventListener('click', () => {
      record('submit', 'pay', { data: Object.assign({}, chosen) });
      answered(() => (chosen.method === 'E-Wallet' ? showEwallet() : showDone()));
    });
    show('payment', h('app-payment-options', null, methods, providers, pay));

    // The tiles arrive after the page itself, and providers after a method is picked.
    later(() => methods.append(...PAYMENT_METHODS.map(([method, offered]) => {
      const tile = h('div', { class: 'bank-type', 'data-rec': `pay.method[${method}]` }, method);
      tile.addEventListener('click', () => {
        chosen.method = method;
        chosen.provider = null;
        select(tile);
        later(() => providers.replaceChildren(...offered.map((provider) => {
          const option = h('div', { class: 'bank-text', 'data-rec': `pay.provider[${provider}]` }, provider);
          option.addEventListener('click', () => {
            chosen.provider = provider;
            select(option);
          });
          return option;
        })));
      });
      return tile;
    })));
  }

  function showEwallet() {
    const button = (text, rec) => h('button', { type: 'button', class: 'mob-bot-btn search_btn', 'data-rec': rec }, text);
    const confirm = button('CONFIRM', 'ewallet.confirm');
    confirm.addEventListener('click', () => later(showDone));
    show('ewallet', h('app-ewallet-confirm', null, h('p', null, 'Pay from the wallet?'), button('CANCEL', 'ewallet.cancel'), confirm));
  }

  function showDone() {
    show('done', h('app-standin-done', null, 'End of the stand-in. Nothing was booked and nothing was paid.'));
  }

  // ---- start ----
  if (cfg.clock) setClock(cfg.clock);
  tick();
  setInterval(tick, 250);
  root.append(header, main, loading);
  if (cfg.languagePopup) root.append(languageDialog());
  showHome();

  // What the runner reads, and the one thing it can change while a scenario runs.
  window.__standin = { log, setClock };
})();
