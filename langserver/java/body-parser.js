const Token = require('./parsetypes/token');
const Declaration = require('./parsetypes/declaration');
const TypeIdent = require('./parsetypes/typeident');
const { parse_expression, ExpressionText, ParsedExpression } = require('../../src/expression/parse');
const { TextBlock, TextBlockArray, BlockRange } = require('./parsetypes/textblock');

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
    const src = text.slice(index);
    const e = new ExpressionText(src);
    const parsed = parse_expression(e);
    //console.log(parsed);
    let consumed = index + src.lastIndexOf(e.expr);
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
    text = text.replace(/(\/\/.*|\/\*[\D\d]*?\*\/|\s+)|(".+?")/g, (_,comment,str) => 
        str ? 
        `"${' '.repeat(str.length-2)}"`
        : ' '
    ).replace(/;/g,';\n');

    const re = /(\s+)|(["'\d]|\b(?:true|false|null)\b)|\b(if|switch|while|else|for|case|default|do|try|finally|catch|return|break|continue)\b|(\bnew\b)|(\w+|\d+(?:\.\d*)?[eE][+-]?\w*|[!~+-])|([;{}():])|(.)/g;
    for (let m; m = re.exec(text);) {
        if (m[1]) {
            // ignore ws + comments
            continue;
        }
        console.log(re.lastIndex)
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
            const local_var_re = /(final +)?(\w+(?: *\. *\w+)*(?: *<.*?>)?(?: *\[ *\])*)( +)(\w+)( *\[ *\])*/g;
            local_var_re.lastIndex = m.index;
            const local_var_match = local_var_re.exec(text);
            if (local_var_match && local_var_match.index === m.index) {
                m = local_var_match;
                // it looks like a local variable declaration
                const typeident = new TypeIdent([new Token(text_index + m.index, m[2], '', null)]);
                const local_var_decl = new LocalVariableDeclaration([], typeident);
                let name_token = new Token(text_index + m.index + (m[1]||'').length + m[2].length + m[3].length, m[4], '', null);
                let postarray_token = m[4] ? new Token(name_token.source_idx + m[4].length, m[5], '', null) : null;
                const vars = [new LocalVariable(local_var_decl, name_token, postarray_token)];

                const next = /( *= *)|( *, *)(\w+)( *\[ *\])*/g;
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
            tokens.shrink(ids[idx], start, end - start, m, replacements[idx]);
            sourcemap = tokens.sourcemap();
            re.lastIndex = 0;
        }
    })

    chunks = [
        /\{([SBVE;]*)(\})/g,          // statement block -> B
        /I([SBVE;])(L[SBVE;])?/g,      // if (Expression) Statement/Block Else -> S
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
                tokens.shrink(ids[idx], start, end - start, m, replacements[idx]);
                sourcemap = tokens.sourcemap();
                re.lastIndex = 0;
            }
        })
        if (old === sourcemap.simplified) break;
    }

    return tokens;

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


module.exports = {
    parseBody,
}
