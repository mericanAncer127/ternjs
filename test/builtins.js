// x: number
// y: number
var x = Math.PI, y = Math.cos(x);

// a: [number]
var a = [1, 2, 3];
// b: [number]
var b = a.slice(2);

// c: number
var c = a.pop()

// d: [string]
var d = ["x"].concat(["hi"]);

// e: [bool]
var e = [true, false, true].filter(function(x){return x;});

// f: [string]
var f = [].map(function() {return "x";});

// g: number
var g = [].reduce(function(a, b) { return a - 2; }, 0);

// h: number
var h = Math.cos.call(null, 10);

// i: fn(digits: number) -> string
var i = (10).toFixed;

// j: [string]
var j = "foo bar baz".split(" ");

// toString: fn() -> string

// k(0): Date
var k = new Date;
