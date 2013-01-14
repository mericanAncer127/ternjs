var fs = require("fs");
var analyze = require("./analyze"), aval = require("./aval");

if (process.argv[2]) outputInfo(process.argv[2]);
else runTests();

function runTests() {
  var files = 0, tests = 0, failed = 0;
  fs.readdirSync("test/").forEach(function(file) {
    ++files;
    aval.withContext(null, function() {
      var info = analyze.analyze("test/" + file);
      var assertion = /\/\/ (\w+)(?:\((d+)\))?: (.*)\n/g, m;

      while (m = assertion.exec(info.text)) {
        ++tests;
        var v = info.env.vars[m[1]];
        if (!v) {
          console.log(file + ": variable " + m[1] + " not defined");
          ++failed;
          continue;
        }
        var type = v.aval.toString(Number(m[2] || 5));
        if (type != m[3]) {
          console.log(file + ": variable " + m[1] + " has type\n  " + type + "\ninstead of expected type\n  " + m[3]);
          ++failed;
        }
      }
    });
  });
  console.log("Ran " + tests + " tests from " + files + " files.");
  console.log(failed ? failed + " failures!" : "All passed.");
}

function outputInfo(file) {
  aval.withContext(null, function() {
    var info = analyze.analyze(file);
    for (var v in info.env.vars)
      console.log(v + ": " + info.env.vars[v].aval.toString(2));
  });
}
