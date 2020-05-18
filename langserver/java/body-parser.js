const Token = require('./parsetypes/token');
const Declaration = require('./parsetypes/declaration');
const TypeIdent = require('./parsetypes/typeident');
const { parse_expression, ExpressionText, ParsedExpression } = require('../../src/expression/parse');

class LocalVariableDeclaration extends Declaration {
    /**
     * @param {*[]} modifiers 
     * @param {TypeIdent} typeident 
     */
    constructor(modifiers, typeident) {
        super(null, null, modifiers);
        this.typeident = typeident;
        /** @type {LocalVariable[]}  */
        this.vars = [];
    }
}

class LocalVariable {
    /**
     * @param {LocalVariableDeclaration} declaration
     * @param {Token} name 
     * @param {Token} arrdims 
     */
    constructor(declaration, name, arrdims) {
        this.declaration = declaration;
        this.name = name;
        this.arrdims = arrdims;
        /** @type {Token} */
        this.equals = null;
        /** @type {ParsedExpression} */
        this.expression = null;
        /** @type {Token} */
        this.comma = null;
    }
}

/**
 * @param {string} text 
 * @param {number} index 
 */
function extractExpression(text, index = 0) {
    const e = new ExpressionText(text.slice(index));
    const parsed = parse_expression(e);
    console.log(parsed);
    let consumed = text.indexOf(e.expr);
    return {
        parsed,
        index: consumed,
    }
}

/**
 * Parse a method body
 * 
 * The parser is an inside-out parser.
 * It works by tokenizing at the lowest level (comments, whitespace, identifiers, literals and symbols)
 * and works its way outward, grouping tokens together in larger and larger chunks that it recognises.
 * 
 * Each stage is forgiving on what it accepts and syntax errors (unexpected or missing tokens) are noted along the way.
 * The final parse stage matches a set of statements - the highest-level concept of a method body.
 * 
 * Once the parse is complete, all the complete expressions in the body can be type-resolved and checked.
 * 
 * @param {string} text 
 * @param {number} text_index 
 */
function parseBody(text, text_index = 0) {
    const tokens = new TextBlockArray('body');

    // preprocess - strip any comments and normalise strings
    text = text.replace(/(\/\/.*|\/\*[\D\d]*?\*\/)|(".+?")/g, (_,comment,str) => 
        str ? 
        `"${' '.repeat(str.length-2)}"`
        : _.replace(/[^\r\n]/g,' ')
    );

    const re = /(\s+)|(["'\d]|\b(?:true|false|null)\b)|\b(if|switch|while|else|for|case|default|do|try|finally|catch|return|break|continue)\b|(\bnew\b)|(\w+)|([;{}():])|(.)/g;
    for (let m; m = re.exec(text);) {
        if (m[1]) {
            // ignore ws + comments
            continue;
        }
        if (m[2]) {
            // string, character, number, boolean or null literal - parse as an expression
            const { parsed, index } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, index - m.index, parsed));
            re.lastIndex = index;
            continue;
        }
        if (m[3]) {
            // statement keyword
            tokens.blocks.push(TextBlock.from(text, m.index, m[0].length));
            continue;
        }
        if (m[4]) {
            // new keyword - need extra handling because of anonymous types
            const { parsed, index } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, index - m.index, parsed));
            re.lastIndex = index;
        }
        if (m[5]) {
            // word - first check if this looks like a variable declaration
            const local_var_re = /(\w+(?: *\. *\w+)*(?: *<.*?>)?(?: *\[ *\])*)( +)(\w+)( *\[ *\])*/g;
            local_var_re.lastIndex = m.index;
            const local_var_match = local_var_re.exec(text);
            if (local_var_match && local_var_match.index === m.index) {
                m = local_var_match;
                // it looks like a local variable declaration
                const typeident = new TypeIdent([new Token(text_index + m.index, m[1], '', null)]);
                const local_var_decl = new LocalVariableDeclaration([], typeident);
                let name_token = new Token(text_index + m.index + m[1].length + m[2].length, m[3], '', null);
                let postarray_token = m[4] ? new Token(name_token.source_idx + m[3].length, m[4], '', null) : null;
                const vars = [new LocalVariable(local_var_decl, name_token, postarray_token)];

                const next = /( *=)|( *, *)(\w+)( *\[ *\])*/g;
                let lastIndex = local_var_re.lastIndex;
                for (;;) {
                    next.lastIndex = lastIndex;
                    let m = next.exec(text);
                    if (!m || m.index !== lastIndex) {
                        break;
                    }
                    lastIndex = next.lastIndex;
                    if (m[1]) {
                        vars[0].equals = new Token(text_index + m.index + m[0].indexOf('='), '=', '', null);
                        // variable initialiser
                        const { parsed, index } = extractExpression(text, next.lastIndex);
                        lastIndex = index;
                        vars[0].expression = parsed;
                    } else {
                        // another variable
                        vars[0].comma = new Token(text_index + m.index + m[0].indexOf(','), ',', '', null);
                        name_token = new Token(text_index + m.index + m[2].length, m[3], '', null);
                        postarray_token = m[4] ? new Token(name_token.source_idx + m[3].length, m[4], '', null) : null;
                        vars.unshift(new LocalVariable(local_var_decl, name_token, postarray_token));
                    }
                }
                local_var_decl.vars = vars.reverse();

                tokens.blocks.push(new LocalVariableDeclBlock(text, local_var_match.index, lastIndex, local_var_decl));

                re.lastIndex = lastIndex;
                continue;
            }
            const { parsed, index } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, index - m.index, parsed));
            re.lastIndex = index;
            continue;
        }
        if (m[6]) {
            // brackets, scopes or semcolon
            tokens.blocks.push(TextBlock.from(text, m.index, m[0].length));
            continue;
        }
        // anything else is invalid
        tokens.blocks.push(new InvalidTextBlock(text, m.index, m[0].length));
    }
    tokens;

    // convert the tokens to their simplified form for grouping
    let sourcemap = tokens.sourcemap();

    // convert simple statements and expressions
    let chunks = [
        /(for)(\(?)([XY]?)(;?)(X?)(;?)(X?)(\)?)/g, // for -> F
        /(if)(\(?)(X?)(\)?)/g,         // if -> I
        /(while)(\(?)(X?)(\)?)/g,      // while -> W
        /(switch)(\(?)(X?)(\)?)/g,     // switch -> P
        /(catch)(\(?)(V?)(\)?)/g,      // catch -> C
        /(case)(X?)(:?)/g,            // single case -> Q
        /(default)(:?)/g,             // default case -> Q
        /(return|break|continue)(X?)(;?)/g, // return/break/continue -> S
        /(finally)/g,                 // finally block -> N
        /(else)/g,                    // else statement -> L
        /Y(;?)/g,                    // variable declaration -> V
        /X(;?)/g,                    // statement expression -> E
    ]

    let replacements = 'FIWPCQQSNLVE';
    let ids = 'for_hdr if_hdr while_hdr switch_hdr catch case default rbc finally else localvar expr'.split(' ');
    chunks.forEach((re,idx) => {
        re.lastIndex = 0;
        for (let m; m = re.exec(sourcemap.simplified);) {
            let start = sourcemap.map[m.index];
            let end = sourcemap.map[m.index + m[0].length];
            tokens.shrink(ids[idx], start, end - start, replacements[idx]);
            sourcemap = tokens.sourcemap();
            re.lastIndex = 0;
        }
    })

    chunks = [
        /\{([SBVE;]*)(\})/g,          // statement block -> B
        /I([SBVE;])L?[SBVE;]/g,      // if (Expression) Statement/Block Else -> S
        /F[SBVE;]/g,                // for loop -> S
        /P(\{)(Q+[SBVE]*)*(\}?)/g,  // switch(Expression){ Q(caseblock),... } -> S
        /try(B)(C?B?)(N?B?)/g,          // try, Block, catch/finally -> S
        /do(B)(W?)(;?)/g,          // do Block While -> S
        /(?<!\})W[SVBE;]/g,          // While -> S - this needs the no-pre-brace check to allow do-while to pair correctly
    ]
    replacements = 'BSSSSSS';
    ids = 'block if for switch try dowhile while'.split(' ');
    for (;;) {
        let old = sourcemap.simplified;
        chunks.forEach((re,idx) => {
            re.lastIndex = 0;
            for (let m; m = re.exec(sourcemap.simplified);) {
                let start = sourcemap.map[m.index];
                let end = sourcemap.map[m.index + m[0].length];
                tokens.shrink(ids[idx], start, end - start, replacements[idx]);
                sourcemap = tokens.sourcemap();
                re.lastIndex = 0;
            }
        })
        if (old === sourcemap.simplified) break;
    }

    return tokens;

}

const expressions = [
    '1 for(){}',
    'a',
    'true',
    'null',
    `""`,
    `'c'`,
    // operators
    `1 + 2`,
    `1 - 2`,
    `1 * 2`,
    `1 / 2`,
    `1 % 2`,
    `1 & 2`,
    `1 | 2`,
    `1 ^ 2`,
    `1 < 2`,
    `1 <= 2`,
    `1 << 2`,
    `1 > 2`,
    `1 >= 2`,
    `1 >> 2`,
    `1 == 2`,
    `1 instanceof 2`,
    // assignment operators
    `a += 2`,
    `a -= 2`,
    `a *= 2`,
    `a /= 2`,
    `a %= 2`,
    `a &= 2`,
    `a |= 2`,
    `a ^= 2`,
    `a <<= 2`,
    `a >>= 2`,
    // member, array, methodcall
    `a.b`,
    `a.b.c`,
    `a[1]`,
    `a[1,2]`,
    `a[1][2]`,
    `a()`,
    `a(b)`,
    `a(b, "")`,
    `a.b()`,
    `a.b()[1]`,
];
expressions.map(e => {
    extractExpression(e);
})

const src =
`for (int i=0; i < 10; i++) {
    do {
        if (i) {
            System.out.println("1234");
        }
        #
        switch(x) {
            case 4:
            case 5:
                return x;
            case 6:
            default:
                return;
        }
        while (x > 0) true;
    } while (i > 0);
    while (x > 0)
        System.out.println("1234");
}
`

class BlockRange {

    get end() { return this.start + this.length }
    get text() { return this.source.slice(this.start, this.end) }
    /**
     * 
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     */
    constructor(source, start, length) {
        this.source = source;
        this.start = start;
        this.length = length;
    }
}

class TextBlock {
    /**
     * @param {BlockRange|TextBlockArray} range
     * @param {string} simplified
     */
    constructor(range, simplified) {
        this.range = range;
        this.simplified = simplified;
    }

    /**
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     * @param {string} [simplified] 
     */
    static from(source, start, length, simplified) {
        const range = new BlockRange(source, start, length);
        return new TextBlock(range, simplified || range.text);
    }

    toSource() {
        return this.range instanceof BlockRange
            ? this.range.text
            : this.range.toSource()
    }
}

class ParsedExpressionBlock extends TextBlock {
    /**
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     * @param {ParsedExpression} expression 
     */
    constructor(source, start, length, expression) {
        super(new BlockRange(source, start, length), 'X');
        this.expression = expression;
    }
}

class LocalVariableDeclBlock extends TextBlock {
    /**
     * @param {string} source 
     * @param {number} start 
     * @param {number} end 
     * @param {LocalVariableDeclaration} decl 
     */
    constructor(source, start, end, decl) {
        super(new BlockRange(source, start, end - start), 'Y');
        this.decl = decl;
    }
}

class InvalidTextBlock extends TextBlock {
    /**
     * @param {string} source 
     * @param {number} start 
     * @param {number} length 
     */
    constructor(source, start, length) {
        super(new BlockRange(source, start, length), '');
    }
}

class TextBlockArray {
    /**
     * @param {string} id
     * @param {TextBlock[]} [blocks] 
     */
    constructor(id, blocks = []) {
        this.id = id;
        this.blocks = blocks;
    }

    get simplified() {
        return this.blocks.map(tb => tb.simplified).join('');
    }

    sourcemap() {
        let idx = 0;
        const parts = [];
        /** @type {number[]} */
        const map = this.blocks.reduce((arr,tb,i) => {
            arr[idx] = i;
            parts.push(tb.simplified);
            idx += tb.simplified.length;
            return arr;
        }, []);
        map[idx] = this.blocks.length;
        return {
            simplified: parts.join(''),
            map,
        }
    }

    /**
     * @param {string} id
     * @param {number} start 
     * @param {number} count 
     * @param {string} simplified 
     */
    shrink(id, start, count, simplified) {
        if (count <= 0) return;
        const collapsed = new TextBlockArray(id, this.blocks.splice(start, count, null));
        this.blocks[start] = new TextBlock(collapsed, simplified);
    }

    get source() { return this.toSource() }

    toSource() {
        return this.blocks.map(tb => tb.toSource()).join('');
    }
}


parseBody(src);
