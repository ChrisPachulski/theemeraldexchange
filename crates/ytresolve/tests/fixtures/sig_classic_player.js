// PINNED FIXTURE — a minimised YouTube player `base.js` in the *classic*
// signature-cipher shape (the form yt-dlp's `_parse_sig_js` + `extract_object`
// were written against, before the player moved to `player_es6`). Hand-authored
// to exercise the exact extraction path in `cipher.rs` without shipping a 2 MB
// real base.js into the repo or hitting the network.
//
// The descrambler `Yo` does, in order: split("") -> reverse -> swap[0<->3]
// -> splice(0,2) -> reverse -> join(""). For input "ABCDEFGHIJ" the result is
// "ABCDEFJH" (verified by running this exact JS in node; see the cipher.rs test).
//
// Extraction must:
//   1. name the descrambler via the split/join function-assignment pattern,
//   2. balance-brace its body,
//   3. find the helper object from the first IDENT.method( call in the body and
//      balance-brace its declaration,
//   4. assemble a self-contained snippet boa can run.
//
// (This comment deliberately avoids writing any `var <name> = {` or
// `function <name>(` token so the extractor's regexes match only the real code
// below, not this prose.)

var _yt_player_dummy_ = {};

'use strict';
var gWQ = "a,b,c,d,e".split(",");

var Xo = {
  Zk: function(a) { a.reverse(); },
  Wp: function(a, b) { var c = a[0]; a[0] = a[b % a.length]; a[b % a.length] = c; },
  Lm: function(a, b) { a.splice(0, b); }
};

Yo = function(a) {
  a = a.split("");
  Xo.Zk(a);
  Xo.Wp(a, 3);
  Xo.Lm(a, 2);
  Xo.Zk(a);
  return a.join("");
};

// Call-site (used only for function-NAME extraction, never executed here):
// PR&&(PR=Yo(decodeURIComponent(PR)),u.set(sp,encodeURIComponent(PR)));
var _ref = Yo;
