// WATCHER agent — action dispatch.
//
// This is where a model's INTENTION meets policy. The model chooses what to
// attempt, from a fixed enum; it never decides what is permitted. Every branch
// below runs the policy check FIRST, in ordinary JavaScript, and only then
// touches the page. There is no path through this file that reaches a browser
// mutation without a check in front of it, and nothing a page says can reword,
// override or claim authority over a `===` comparison.
//
// Everything is recorded — the attempt, the check, the outcome — whether the
// action happened or not. A refusal is evidence and belongs in the log next to
// the attempt that earned it.
//
// dryRun performs every check and every audit write, then stops short of the
// mutation. Use it before pointing the agent at a live site.

const REFUSED = (reason, extra = {}) => ({ ok: false, refused: true, reason, ...extra });
const DONE = (result, extra = {}) => ({ ok: true, refused: false, result, ...extra });

/**
 * @param {{policy: object, browser: object, gate: object|null,
 *          audit: object|null, dryRun?: boolean}} deps
 */
export function createActions({ policy, browser, gate = null, audit = null, dryRun = false } = {}) {
  if (!policy) throw new Error('createActions needs a policy');
  if (!browser) throw new Error('createActions needs a browser');

  const record = (event) => { audit?.record(event); };

  // A control is sensitive when policy says the verb it performs needs a
  // human. Everything the control says about itself is scanned — its text,
  // its name, and the action of the form it sits in — because a click is not
  // inherently safe: a click on "Place order" is a purchase.
  async function approveIfSensitive({ verb, target, summary, values }) {
    if (!verb) return { needed: false, decision: null };
    const act = policy.canAct(verb);
    if (!act.needsApproval) return { needed: false, decision: null };

    if (!gate) {
      // No gate wired means no human can be asked, and an unaskable question
      // fails closed exactly like an unanswered one.
      record({ type: 'gate_missing', verb, target });
      return { needed: true, decision: 'reject' };
    }
    const decision = await gate.request({ verb, target, summary, values });
    return { needed: true, decision };
  }

  async function navigate(decision) {
    const url = String(decision.target || '');

    // 1. Before the fetch.
    const before = policy.canVisit(url);
    record({ type: 'policy_canVisit', url, allowed: before.allowed, reason: before.reason });
    if (!before.allowed) return REFUSED(before.reason, { url });

    if (dryRun) return DONE({ url, dryRun: true });

    // 2. The fetch.
    const landed = await browser.navigate(url);

    // 3. After the fetch. Spec 5.1: redirects are re-checked after
    //    resolution. A page that redirects to a disallowed host is dropped,
    //    not followed — and critically, not READ either: returning refused
    //    here means the loop never snapshots it, so its text never reaches
    //    the model.
    const after = policy.canVisit(landed.url);
    record({
      type: 'policy_canVisit_afterRedirect',
      requested: url, landed: landed.url, chain: landed.chain,
      allowed: after.allowed, reason: after.reason
    });
    if (!after.allowed) {
      return REFUSED(`redirected to ${landed.url}, which ${after.reason}`, { url: landed.url, chain: landed.chain });
    }
    return DONE(landed);
  }

  // Read-only. Nothing to check: the page is already open and already read.
  async function extract(decision) {
    record({ type: 'extract', target: decision.target || null });
    return DONE({ extracted: decision.target || null, note: decision.reason || '' });
  }

  async function click(decision) {
    const ref = String(decision.target || '');
    let el;
    try { el = browser.describe(ref); }
    catch (err) { return REFUSED(err.message, { ref }); }

    const verb = policy.verbOfControl({ text: el.text, name: el.name, formAction: el.formAction });
    record({
      type: 'policy_verbOfControl', ref,
      control: { text: el.text, name: el.name, formAction: el.formAction },
      verb
    });

    const { needed, decision: human } = await approveIfSensitive({
      verb,
      target: el.text || el.name || ref,
      summary: `Click "${el.text || ref}", which performs: ${verb}`,
      values: { ref, form: el.formAction || '(none)' }
    });
    if (needed) {
      record({ type: 'gate_result', action: 'click', ref, verb, decision: human });
      if (human !== 'approve') return REFUSED(`a human did not approve clicking "${el.text || ref}" (${verb})`, { ref, verb });
    }

    if (dryRun) return DONE({ clicked: ref, dryRun: true, verb });
    return DONE(await browser.click(ref));
  }

  async function fill(decision) {
    const ref = String(decision.target || '');
    const value = String(decision.value ?? '');
    let el;
    try { el = browser.describe(ref); }
    catch (err) { return REFUSED(err.message, { ref }); }

    // The field as the DOM actually describes it — not as a snapshot
    // flattened it. webcmd's `act` snapshot drops type="password" entirely,
    // so canFill's first rule would never fire if this came from there.
    const check = policy.canFill(el, value);
    record({
      type: 'policy_canFill', ref,
      field: { type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, label: el.label },
      allowed: check.allowed, reason: check.reason
      // The VALUE is deliberately not recorded. This log is a product output
      // that outlives the run, and a refusal reason already says what was
      // wrong without writing the secret into a file.
    });
    if (!check.allowed) return REFUSED(check.reason, { ref });

    if (dryRun) return DONE({ filled: ref, dryRun: true });
    return DONE(await browser.fill(ref, value));
  }

  async function submit(decision) {
    const ref = String(decision.target || '');
    let el;
    try { el = browser.describe(ref); }
    catch (err) { return REFUSED(err.message, { ref }); }

    // submit is one of the eight verbs that always require a human, so this
    // always asks. It does not consult verbOfControl first — a submit is a
    // submit whatever the button happens to be labelled.
    const { needed, decision: human } = await approveIfSensitive({
      verb: 'submit',
      target: el.formAction || el.text || ref,
      summary: `Submit the form containing "${el.text || ref}"`,
      values: { ref, form: el.formAction || '(none)' }
    });
    record({ type: 'gate_result', action: 'submit', ref, verb: 'submit', decision: human });
    if (needed && human !== 'approve') {
      return REFUSED('a human did not approve submitting this form', { ref });
    }

    if (dryRun) return DONE({ submitted: ref, dryRun: true });
    return DONE(await browser.submit(ref));
  }

  async function finish(decision) {
    record({ type: 'finish', reason: decision.reason || '' });
    return DONE({ finished: true, answer: decision.target || decision.value || decision.reason || '' });
  }

  // A NULL-PROTOTYPE map, and a typeof check at the lookup. A plain object
  // literal inherits from Object.prototype, so HANDLERS['__proto__'] returns
  // that prototype and HANDLERS['constructor'] returns the Object constructor
  // — a callable. Dispatching {action:'constructor'} would then have invoked
  // Object(decision), which returns the decision itself, and the result would
  // have been recorded as a COMPLETED action. The model picks `action` from a
  // schema enum, but this dispatch must not depend on that enum having been
  // honoured: the whole point of checking in JavaScript is that it holds when
  // the layer above it does not. Found by test, not by review.
  const HANDLERS = Object.assign(Object.create(null), { navigate, extract, click, fill, submit, finish });

  /**
   * Run one decision. Never throws for a policy refusal — a refusal is a
   * normal outcome the loop records and carries on from (spec 7).
   */
  async function dispatch(decision) {
    const action = decision && decision.action;
    const handler = typeof action === 'string' ? HANDLERS[action] : undefined;
    record({ type: 'action_attempted', action, target: decision?.target ?? null, reason: decision?.reason ?? null });

    if (typeof handler !== 'function') {
      const reason = `"${action}" is not an action this agent performs`;
      record({ type: 'action_refused', action, reason });
      return REFUSED(reason);
    }

    let outcome;
    try {
      outcome = await handler(decision);
    } catch (err) {
      // A browser failure is not a policy refusal, and must not be recorded
      // as one. The loop decides whether it is fatal.
      record({ type: 'action_error', action, message: String(err.message || err) });
      return { ok: false, refused: false, error: true, reason: String(err.message || err) };
    }

    record({
      type: outcome.refused ? 'action_refused' : 'action_completed',
      action,
      reason: outcome.reason ?? null
    });
    return outcome;
  }

  return { dispatch, dryRun };
}
