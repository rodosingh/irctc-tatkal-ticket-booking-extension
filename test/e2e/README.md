# End-to-end tests against a stand-in booking site

`npm run test:e2e` loads the built extension from `dist/` into Chromium, serves
a local stand-in for the booking site, lets the extension walk its flow there
(home page to payment page) and checks what it did.

The stand-in is not the real site and was not copied from it. It was written
from `chrome-extension/src/scripts/user-script.js`: every element exists
because that script looks for it, apart from two controls for the person
(another captcha, and Back on the review page). A green run therefore proves
the extension against the assumptions listed at the end of this file, not
against the real pages.

## It never touches the real site

- Every browser is started with
  `--host-resolver-rules=MAP www.irctc.co.in:443 127.0.0.1:<port>, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`
  and `--no-proxy-server` (`chromeArgs` in `run.js`). The booking host
  resolves to the stand-in; every other name fails to resolve.
- Before any scenario the runner checks this in a browser set up the same way.
  First a request to `localhost` must fail with `ERR_NAME_NOT_RESOLVED`:
  without the catch-all rule that name is the stand-in's own port, so this
  check cannot leave the machine. Only then is the booking host asked for, and
  it must answer with a marker that is new on every run. Last, requests to
  `example.com` and `api.ocr.space` must fail to resolve as well. If any of
  that fails, no scenario runs (exit 2).
- When each browser closes, the runner reads the network log Chromium wrote
  for it and stops the whole run (exit 2) if a TCP connection went anywhere but
  the stand-in, if a UDP datagram was sent at all, or if the log cannot be
  read.
- A request to another host fails at name resolution, before any connection,
  so the network log does not show it. The runner records each one a
  scenario's page attempts, and the scenario fails unless it names them
  (`outsideRequests`).
- The stand-in listens on `127.0.0.1` only, on a free port, with a throwaway
  self-signed certificate made by `openssl` for the run.
- All data is invented. Nothing logs in, books or pays.

One thing the resolver rules do not cover: when a tab *navigates* to a name
that does not resolve, Chromium tests the machine's DNS with a lookup of its
own (`google.com`, sent to the configured resolver and to a public one). The
runner switches that off in every profile it creates (`alternate_error_pages`
in `Default/Preferences`). Scenarios must still not navigate the page anywhere
but the stand-in; the network log check above is what catches a lookup that
gets out.

## Captchas

A captcha in the stand-in is a plain image with visible letters and a text
box. The scenario says which text the image shows and what the person types.
The test types it with real key presses, without clicking or focusing the box
first, so the letters only arrive if the extension has put the cursor there;
Enter is a real key press too. Nothing here reads the image, and the runner
fails any of these scenarios in which something other than the person put text
in a captcha box.

While the person types, the extension shows a note with the id
`tatkal-captcha-note`. The scenarios read its text, check that it is in view
and not over the captcha, and check that it is gone when the step is over.

`autoSolveCaptcha` is on in one scenario, only to show that those two branches
of the extension still behave as they did. The reader they call has no service
it can reach from the test browser, so it returns nothing; its two attempts to
reach one are the only `outsideRequests` any scenario names. The extension
does not place the cursor on that path, so there the test clicks the box
first, as the person would.

## Running

Needs Node 20 or newer, `openssl`, and Chromium (recent branded Google Chrome
builds ignore `--load-extension`).

```sh
npm install                            # brings in playwright-core
npx playwright-core install chromium   # or point CHROME_PATH at a Chromium binary
npm run build                          # the tests use dist/ as it is, they do not build
npm run test:e2e
npm run test:e2e -- "autoPay on"       # only scenarios whose name contains this
E2E_LOG=1 npm run test:e2e             # also print what the stand-in recorded
```

Exit code 0: all scenarios passed. 1: a scenario failed. 2: could not run:
no `dist/`, a `dist/` older than the sources it is built from, or isolation
not verified. A failing scenario prints the stand-in's record, the dialogs
seen and the last lines the extension logged. A full run takes a little over
three minutes; nearly all of it is the extension's own fixed waits.

## Files

- `run.js` - starts the server and the browsers, checks isolation, runs the scenarios.
- `scenarios.js` - the scenarios and the invented settings they store.
- `server.js` - the HTTPS server.
- `site/` - the stand-in: one page, `standin.js` renders every step in it.

The stand-in records each click, each typed or chosen value and each form
submission, in order, with the time since load and the page clock. `by` says
whether an event came from a script (`click()`, `dispatchEvent()`: the
extension) or from real input (the test acting as the person, or the browser
submitting a form for them on Enter). It also records each captcha it draws
and each seat status it shows on the review page (`shown`), and each time a
captcha box gets the cursor (`focus`). A scenario
configures it through the `?standin=<JSON>` query; the options are listed at
the top of `site/standin.js`.

## Adding a scenario

Add an object to the array in `scenarios.js`:

```js
{
  name: 'what it shows',
  site: { loginCaptcha: ['R7KQ2M'] },        // stand-in options
  settings: settings({ autoPay: true }),      // stored for the extension; overrides the defaults
  async drive(t) {                            // act as the person, and wait for the extension
    await cursorInCaptcha(t, 'login.captcha');
    await typeAndEnter(t, 'R7KQ2M');
    await t.until('the sign-in', (log) => of(log, 'submit', 'login').length > 0);
  },
  verify(t, log) {                            // runs even if drive() gave up
    t.same('one sign-in', submitted(log, 'login').length, 1);
  },
}
```

`t` has `until(what, (log) => done, timeoutMs)`, `pause(ms)`, `readLog()`,
`setClock('HH:MM:SS')`, `switchOff()` (stores the settings again with Auto
Booking off, as the options page does), `page` (Playwright's, for acting as
the person), `dialogs` (any prompt or alert that came up; none is expected),
`check(name, ok, detail)` and `same(name, actual, expected)`. Run
with `E2E_LOG=1` to see the keys the stand-in records. Each scenario gets a
fresh browser profile. `booking(...)` builds a whole-flow scenario whose
checks follow from its settings.

A scenario whose page is expected to attempt a request to another host lists
it under `outsideRequests`, as `'POST https://host/path'`. Any other attempt
fails the scenario. So does a prompt or an alert, and so does text put in a
captcha box by anything but the person, unless the scenario turns
`autoSolveCaptcha` on. The runner checks these three after `verify`.

If the extension starts looking for something new, add it to
`site/standin.js` from the selector in `user-script.js`, give it a `data-rec`
key, and add the assumption below.

## What the stand-in assumes about the real pages

General

- One document; steps appear and disappear in it and the address never
  changes. Elements match the default selectors in `user-script.js` (no
  selector overrides are stored).
- A field's value reaches the page only through the `input` event (text boxes)
  or `change` event (selects) fired on that field, bubbling or not, as with a
  framework-bound form. Checkboxes and radios are read from their state.
- The result of a click shows up 150 ms later (500 ms for sign-in, review
  Continue and Pay, or `answerTime`), except where the extension reads it
  sooner (below). The real site is slower and less regular; the extension's
  fixed waits are proven only against these delays.
- The clock and the seat status on the review page change their text where it
  is, as a bound text does: no element is added or removed.
- Forms accept whatever was filled in. Only captchas are checked.

Home page and sign-in

- `app-header` is there from the start, with the login link `a.loginText` and
  the clock in `.h_head1 > span strong`, its text containing `[HH:MM:SS]`.
- The language dialog, when shown, is a `p-dialog` present from the start
  (the extension gives it 2.5 s); its buttons carry `aria-label` "Please select your preferred language ..."
  and the language name as their text; a click removes it.
- The login link opens `app-login` with `input[formcontrolname="userid"]`,
  `input[formcontrolname="password"]` and `button[type="submit"]`. A captcha
  is `app-captcha` holding `img.captcha-img` and `input#captcha`. Without a
  captcha the box is absent, or present but not rendered. A captcha is drawn
  in the same tick as its form, here and on the review page.
- A sign-in that succeeds removes `app-login`. One that is refused keeps it
  and shows a new captcha in an empty box.
- Sign-in and the review step are forms with a submit button, so Enter in the
  captcha box sends the form through the browser. With `pageEnterKey` the
  page uses a handler of its own on the form in place of that, on `keydown`
  or on `keyup`.
- A captcha box that is shown is `required`: while it is empty the browser
  does not send the form, whoever presses the button, and puts the cursor in
  the box.
- A new captcha re-creates the image and the box together
  (`captchaRedraw: 'replace'`, the default). With `'src'` the image's `src`
  changes where it is, the cursor leaves the box, and a moment later an empty
  box takes the old one's place. With `'box'` a refused captcha stays and
  only its box is replaced by an empty one. With `'none'` a refused captcha
  stays as it was.
- Next to the captcha is a link that draws another one. The extension does
  not look for it; it stands for the site's own control.
- The journey form `app-jp-input` is on the home page before and after
  sign-in: `#origin input`, `#destination input`, `#jDate input`,
  `#journeyQuota > div` and `button[type="submit"].search_btn`.
- Typing a station code lists `.ui-autocomplete-items li` within 600 ms, the
  first being the station meant; picking one closes the list, so one list is
  open at a time.
- The date box takes `DD/MM/YYYY` typed a character at a time.
- A click on `#journeyQuota > div` lists `p-dropdownitem span` inside
  `#journeyQuota` within 500 ms, with TATKAL before PREMIUM TATKAL.

Train list

- Search shows `app-train-list` with every train already in it.
- A train is an `app-train-avl-enq` with one `.train-heading` containing its
  number. Class cells are `.pre-avl`, the first `strong` holding the class
  name with its code, such as `AC 3 Tier (3A)`.
- Choosing a class replaces the class cells with a `p-tabmenu` (selected tab:
  `li[role="tab"][aria-selected="true"][aria-expanded="true"] a > div`) and one
  `.pre-avl` per date. The first is the journey date and its first `strong`
  reads like `Fri, 07 Mar` (two-digit day, three-letter month).
- Each availability status is added to its cell as a separate node matching
  `.link.ng-star-inserted`, after the cell itself is on the page (the
  extension counts exactly these insertions). A click on the selected tab asks
  again.
- A click on a date cell enables Book Now (`button.btnDefault.train_Search`
  loses `disable-book`) at once. Book Now goes straight to the passenger page.

Passenger page

- `app-passenger-input` starts with one `app-passenger` row inside `p-panel`.
  `+ Add Passenger` is the first `.prenext`, inside an `a`; a click adds a
  row at once. `a.fa-remove` removes its row.
- A row has `p-autocomplete input` (name),
  `input[formcontrolname="passengerAge"]` and selects
  `passengerGender` (M, F, T), `passengerBerthChoice` (LB, MB, UB, SL, SU;
  empty for no preference) and `passengerFoodChoice` (V, N, J, F, G, D).
  These are the codes the options page stores, with two exceptions that no
  scenario uses: for no berth preference it stores `No Preference`, and for
  sitting classes it offers `WS` (window side), which the stand-in lacks.
- With saved passengers, typing a name lists the matches in
  `.ui-autocomplete-items li` within 600 ms and picking one fills name, age
  and gender.
- `#mobileNumber`, `#autoUpgradation` and `#confirmberths` are plain inputs.
  Insurance radios are `input[type="radio"][name="travelInsuranceOpted-0"]`
  and payment-type radios `p-radiobutton[name="paymentType"] input`, each
  inside a `label` whose text names the choice (`Yes`/`No`; `BHIM/UPI` or
  `... Wallets ...`).
- Continue is the first `button.btnDefault.train_Search` in the page.

Review and payment

- `app-review-booking` holds `app-train-header` with a `.AVAILABLE` element
  whose text is the seat status, there with the page or `seatsAfter` ms
  later. With `seatsWhenRefused` a refused captcha turns it into a `.WL`
  element with that text. Below it are a summary tall enough to leave what follows
  below the fold, the captcha (as on sign-in) when there is one, Continue as
  `button.btnDefault.train_Search`, and a Back button that returns to the
  passenger page (the extension does not look for it).
- `app-payment-options` gets its method tiles `#pay-type .bank-type` a moment
  after it appears. Providers `#bank-type .bank-text` are listed only after a
  method is picked. Tile and provider texts contain what the options page
  stores: `BHIM/ UPI/ USSD` with `PAYTM`, `E-Wallet` with `IRCTC eWallet`.
- The Pay button is `button.btn-primary.ng-star-inserted`, reads `Pay & Book`,
  is there from the start and is the first such button in the document.
- Pay with the wallet shows `app-ewallet-confirm` with
  `button.mob-bot-btn.search_btn` buttons, one reading `CONFIRM`.

## What a green run does not cover

Not modelled by the stand-in: infants, the "no food" checkbox and its dialog,
the route confirmation pop-up, starting from the train list
(`app-modify-search`), waiting-list or sold-out trains, site errors, session
expiry, a slow or failing network, and anything after the Pay button.

Selectors of the extension that nothing in the stand-in matches:

- `#bank-type .pay_tax_text`, the second form of a payment provider.
- `input#origin`, `input#destination` and `input#jDate`. The stand-in has the
  `#origin input` form of each.

Branches of the extension that no scenario takes:

- `confirmberths` on, with or without a confirmed berth on offer. That is the
  only use of the `.AVAILABLE` status inside a date cell.
- The configured train missing from the list, its class not offered, and a
  first date cell that is not the journey date.
- PREMIUM TATKAL, and GENERAL on its opening day.
- An empty user id or password, and a mobile number that is not ten digits.
- A single name picked from the saved passenger list, and a name that list
  never offers.
- A payment method or provider that is not on the payment page.
- Auto Booking switched off anywhere but at the login captcha, and the saved
  details cleared at any point.
- `autoSolveCaptcha` on without `autoSubmitCaptcha`.
- A language other than English. The stand-in's other button reads `Hindi`,
  where the options page stores `हिंदी`.
- A review captcha that is present but not rendered, or refused although it
  was typed right. The stand-in options `reviewCaptchaUnpainted` and
  `reviewRejects` are used by no scenario.
- The service worker's alarm and notification, and the options page beyond
  the defaults it stores on first run.

## Test settings

Every scenario stores the settings in `settings()` in `scenarios.js`, all
invented. Three things differ from what the options page would store:

- `refreshTime` is 500 ms, not the default 5000, to keep the runs short.
- `debugMode` is on, so that the extension's log can be shown when a scenario
  fails.
- `scheduleDate` and `loginMinutesBefore` are left out, so the service worker
  never sets its alarm.
