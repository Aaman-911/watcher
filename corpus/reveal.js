/* WATCHER — reveal.js
 *
 * Adds a fixed "Reveal hidden content" button to any corpus page.
 * Pressing it outlines every injected element in thick red, forces it
 * visible, and labels it with the concealment technique used.
 * Pressing it again puts the page back exactly as it was.
 *
 * Injected elements opt in with data-injection="<technique>".
 * HTML comments cannot carry attributes, so comments inside <body> are
 * found with a TreeWalker and materialised into a visible red box.
 *
 * Plain browser JavaScript. No dependencies, no external requests.
 */
(function () {
  'use strict';

  var TECHNIQUE = {
    'white-text':   'Hidden — white text on a white background',
    'aria-label':   'Hidden — text inside an aria-label attribute',
    'html-comment': 'Hidden — text inside an HTML comment',
    'fake-system':  'Visible — fake system message from "the operator"'
  };

  var on = false;
  var created = [];   // nodes reveal.js added, removed on toggle off
  var restyled = [];  // {el, style} so the original style attribute returns

  function css() {
    var s = document.createElement('style');
    s.id = 'wr-style';
    s.textContent = [
      '#wr-btn{position:fixed;right:24px;bottom:24px;z-index:2147483647;',
      'background:#111;color:#fff;border:3px solid #fff;border-radius:12px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.4);cursor:pointer;',
      'font:800 19px/1 ui-sans-serif,system-ui,sans-serif;padding:19px 24px;',
      'letter-spacing:.04em}',
      '#wr-btn.on{background:#d90429;border-color:#fff}',
      '#wr-bar{position:fixed;top:0;left:0;right:0;z-index:2147483646;',
      'background:#d90429;color:#fff;text-align:center;padding:18px 12px;',
      'font:800 24px/1.2 ui-sans-serif,system-ui,sans-serif;',
      'letter-spacing:.09em;text-transform:uppercase}',
      '#wr-bar.clean{background:#0b7a3b}',
      '.wr-hit{outline:8px solid #d90429!important;outline-offset:5px!important;',
      'animation:wr-pulse 1.1s ease-in-out infinite!important}',
      '@keyframes wr-pulse{0%,100%{outline-color:#d90429}50%{outline-color:#ff9aab}}',
      '.wr-badge{display:block!important;background:#d90429!important;',
      'color:#fff!important;padding:12px 16px!important;margin:22px 0 0!important;',
      'font:800 20px/1.3 ui-sans-serif,system-ui,sans-serif!important;',
      'letter-spacing:.06em!important;text-transform:uppercase!important;',
      'border-radius:8px 8px 0 0!important}',
      '.wr-box{display:block!important;background:#fff!important;color:#111!important;',
      'border:8px solid #d90429!important;border-top:0!important;',
      'padding:18px!important;margin:0 0 22px!important;white-space:pre-wrap!important;',
      'font:600 18px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace!important;',
      'border-radius:0 0 8px 8px!important}'
    ].join('');
    document.head.appendChild(s);
  }

  function remember(el) {
    restyled.push({ el: el, style: el.getAttribute('style') });
  }

  function force(el) {
    var p = ['color', '#111', 'background', '#fff4f4', 'visibility', 'visible',
             'opacity', '1', 'text-indent', '0', 'font-size', 'inherit'];
    for (var i = 0; i < p.length; i += 2) el.style.setProperty(p[i], p[i + 1], 'important');
    if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'block', 'important');
  }

  function badge(text) {
    var b = document.createElement('div');
    b.className = 'wr-badge';
    b.textContent = text;
    created.push(b);
    return b;
  }

  function box(text) {
    var b = document.createElement('div');
    b.className = 'wr-box';
    b.textContent = text;
    created.push(b);
    return b;
  }

  function comments() {
    var out = [];
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT, null);
    var n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  function bar(count) {
    var b = document.createElement('div');
    b.id = 'wr-bar';
    if (count === 0) {
      b.className = 'clean';
      b.textContent = 'No hidden instructions on this page';
    } else {
      b.textContent = count === 1
        ? '1 hidden instruction on this page'
        : count + ' hidden instructions on this page';
    }
    document.body.appendChild(b);
    created.push(b);
  }

  function reveal() {
    var found = 0;

    var els = document.querySelectorAll('[data-injection]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var kind = el.getAttribute('data-injection');
      var label = TECHNIQUE[kind] || kind;

      remember(el);
      force(el);
      el.classList.add('wr-hit');
      el.parentNode.insertBefore(badge(label), el);

      if (kind === 'aria-label') {
        var v = el.getAttribute('aria-label') || '';
        el.parentNode.insertBefore(box(v), el.nextSibling);
      }
      found++;
    }

    var cs = comments();
    for (var j = 0; j < cs.length; j++) {
      var c = cs[j];
      var host = document.createElement('div');
      host.className = 'wr-hit';
      host.appendChild(badge(TECHNIQUE['html-comment']));
      host.appendChild(box(c.nodeValue.replace(/^\s+|\s+$/g, '')));
      c.parentNode.insertBefore(host, c);
      created.push(host);
      found++;
    }

    bar(found);
    document.documentElement.style.setProperty('scroll-padding-top', '90px');
  }

  function hide() {
    for (var i = 0; i < created.length; i++) {
      if (created[i].parentNode) created[i].parentNode.removeChild(created[i]);
    }
    created = [];
    for (var j = 0; j < restyled.length; j++) {
      var r = restyled[j];
      r.el.classList.remove('wr-hit');
      if (r.style === null) r.el.removeAttribute('style');
      else r.el.setAttribute('style', r.style);
    }
    restyled = [];
  }

  function init() {
    css();
    var btn = document.createElement('button');
    btn.id = 'wr-btn';
    btn.type = 'button';
    btn.textContent = 'Reveal hidden content';
    btn.addEventListener('click', function () {
      on = !on;
      btn.className = on ? 'on' : '';
      btn.textContent = on ? 'Hide hidden content' : 'Reveal hidden content';
      if (on) reveal(); else hide();
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
