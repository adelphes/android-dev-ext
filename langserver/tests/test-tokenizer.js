const { tokenize } = require('../java/tokenizer');

function testTokenize() {
    const tests = [
        // the basics
        { src: 'i', r: [{value: 'i', kind:'ident'}] },
        { src: '0', r: [{value: '0', kind:'int-number-literal'}] },
        { src: `""`, r: [{value: `""`, kind:'string-literal'}] },
        { src: `'x'`, r: [{value: `'x'`, kind:'char-literal'}] },
        { src: `(`, r: [{value: `(`, kind:'open-bracket'}] },
        ...'. , [ ] ? : @'.split(' ').map(symbol => ({ src: symbol, r: [{value: symbol, kind: 'symbol'}] })),
        ...'= += -= *= /= %= >>= <<= &= |= ^='.split(' ').map(op => ({ src: op, r: [{value: op, kind:'assignment-operator'}] })),
        ...'+ -'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'plumin-operator'}] })),
        ...'* / %'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'muldiv-operator'}] })),
        ...'# ¬'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'invalid'}] })),

        // numbers - decimal with exponent
        ...'0.0e+0 0.0E+0 0e+0 0e0 .0e0 0e0f 0e0d'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-exp-number-literal'}] })),
        // numbers - decimal with partial exponent
        ...'0.0e+ 0.0E+ 0e+ 0e .0e 0ef 0ed'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-exp-number-literal'}] })),
        // numbers - not decimal exponent
        { src: '0.0ea', r: [{value: '0.0e', kind:'dec-exp-number-literal'}, {value: 'a', kind:'ident'}] },

        // numbers - decimal (no exponent)
        ...'0.123 0. 0.f 0.0D .0 .0f .123D'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-number-literal'}] })),
        // numbers - not decimal
        { src: '0.a', r: [{value: '0.', kind:'dec-number-literal'}, {value: 'a', kind:'ident'}] },
        { src: '0.0a', r: [{value: '0.0', kind:'dec-number-literal'}, {value: 'a', kind:'ident'}] },

        // numbers - hex
        ...'0x0 0x123456789abcdef 0xABCDEF 0xabcdefl'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'hex-number-literal'}] })),
        // numbers - partial hex
        ...'0x 0xl'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'hex-number-literal'}] })),

        // numbers - decimal
        ...'0 123456789 0l'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'int-number-literal'}] })),

        // strings
        ...[`"abc"`, `"\\n"`, `"\\""`].map(num => ({ src: num, r: [{value: num, kind:'string-literal'}] })),
        // unterminated strings
        ...[`"abc`, `"\\n`, `"\\"`, `"`].map(num => ({ src: num, r: [{value: num, kind:'unterminated-string-literal'}] })),
        // strings cannot cross newlines
        { src: `"abc\n`, r: [{value: `"abc`, kind:'unterminated-string-literal'}, {value: '\n', kind:'wsc'}] },

        // characters
        ...[`'a'`, `'\\n'`, `'\\''`].map(num => ({ src: num, r: [{value: num, kind:'char-literal'}] })),
        // unterminated/invalid characters
        ...[`'a`, `'\\n`, `'\\'`, `''`, `'`].map(num => ({ src: num, r: [{value: num, kind:'char-literal'}] })),
        // characters cannot cross newlines
        { src: `'\n`, r: [{value: `'`, kind:'char-literal'}, {value: '\n', kind:'wsc'}] },

        // arity symbol
        { src: `int...x`, r: [
            {value: `int`, kind:'primitive-type'},
            {value: `...`, kind:'symbol'},
            {value: `x`, kind:'ident'},
        ],},

        // complex inc - the javac compiler doesn't bother to try and sensibly separate +++ - it just appears to 
        // prioritise ++ in every case, assuming that the developer will insert spaces as required.
        // e.g this first one fails to compile with javac
        { src: '++abc+++def', r: [
            {value: '++', kind:'inc-operator'},
            {value: 'abc', kind:'ident'},
            {value: '++', kind:'inc-operator'},
            {value: '+', kind:'plumin-operator'},
            {value: 'def', kind:'ident'},
        ] },
        // this should be ok
        { src: '++abc+ ++def', r: [
            {value: '++', kind:'inc-operator'},
            {value: 'abc', kind:'ident'},
            {value: '+', kind:'plumin-operator'},
            {value: ' ', kind:'wsc'},
            {value: '++', kind:'inc-operator'},
            {value: 'def', kind:'ident'},
        ] },
    ]
    const report = (test, msg) => {
        console.log(JSON.stringify({test, msg}));
    }
    tests.forEach(t => {
        const tokens = tokenize(t.src);
        if (tokens.length !== t.r.length) {
            report(t, `Wrong token count. Expected ${t.r.length}, got ${tokens.length}`);
            return;
        }
        for (let i=0; i < tokens.length; i++) {
            if (tokens[i].value !== t.r[i].value)
                report(t, `Wrong token value. Expected ${t.r[i].value}, got ${tokens[i].value}`);
            if (tokens[i].kind !== t.r[i].kind)
                report(t, `Wrong token kind. Expected ${t.r[i].kind}, got ${tokens[i].kind}`);
        }
    })
}


testTokenize();
