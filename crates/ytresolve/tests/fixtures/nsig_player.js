// PINNED FIXTURE — a minimised player `base.js` exercising the NSIG extraction
// path: a global-array prelude, the `nfunc[idx]` array-indirection at the call
// site, and the `"nn"[+x]` obfuscation of the literal "n". Hand-authored to
// drive cipher.rs's nsig extractor without a 2 MB real base.js or the network.
//
// The n-transform here splits, reverses, appends "X", and joins. For input
// "abcde" the output is "edcbaX" (verified by running this exact JS in node;
// see the cipher.rs nsig fixture test).
//
// Extraction must:
//   1. read the global array prelude (player_js_global_var),
//   2. match the call site and capture nfunc=Naa, idx=0 (nsig_function_name),
//   3. resolve Naa[0] -> the real function name via array_deref,
//   4. balance-brace that function body and run prelude+fn in boa.
//
// (Prose here avoids writing a real `<name> = function(` or `var <name> = [`
// token so the extractor regexes match only the code below.)

'use strict';var gG = "enhanced_except_,reverse,split".split(",");

var Naa = [Xqz];

Xqz = function(d) {
  var b = d.split("");
  b.reverse();
  b.push("X");
  return b.join("");
};

// Call site with array indirection + the "nn"[+x] obfuscation of "n":
// a.D&&(b="nn"[+a.D],c=a.get(b))&&(c=Naa[0](c),a.set(b,c),Naa.length||Xqz("")
var _csite = function(a) {
  var b, c;
  a.D && (b = "nn"[+a.D], c = a.get(b)) && (c = Naa[0](c), a.set(b, c), Naa.length || Xqz(""));
};
