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


/**
 * @param {string} text 
 * @param {number} index 
 */
function extractExpression(text, index = 0) {
    const src = text.slice(index);
    const e = new ExpressionText(src);
    const parsed = parse_expression(e);
    //console.log(parsed);
    //let nex = index + src.lastIndexOf(e.expr);
    return {
        parsed,
        nextIndex: text.length - e.expr.length,
    }
}

/**
 * 
 * @param {RegExpExecArray} local_var_match 
 * @param {number} lastIndex 
 * @param {string} text 
 * @param {number} text_index 
 */
function extractLocalVariableDeclaration(local_var_match, lastIndex, text, text_index) {
    let m = local_var_match;
    // it looks like a local variable declaration
    const typeident = new TypeIdent([new Token(text_index + m.index, m[2], '', null)]);
    const local_var_decl = new LocalVariableDeclaration([], typeident);
    let name_token = new Token(text_index + m.index + (m[1]||'').length + m[2].length + m[3].length, m[4], '', null);
    let postarray_token = m[4] ? new Token(name_token.source_idx + m[4].length, m[5], '', null) : null;
    const vars = [
        new LocalVariable(local_var_decl, name_token, postarray_token)
    ];

    const next_variable_re = /(\s*=\s*)|(\s*,\s*)(\w+)(\s*\[\s*\])*/g;
    for (;;) {
        next_variable_re.lastIndex = lastIndex;
        let m = next_variable_re.exec(text);
        if (!m || m.index !== lastIndex) {
            break;
        }
        lastIndex = next_variable_re.lastIndex;
        if (m[1]) {
            vars[0].equals = new Token(text_index + m.index + m[0].indexOf('='), '=', '', null);
            // variable initialiser
            const { parsed, nextIndex } = extractExpression(text, next_variable_re.lastIndex);
            lastIndex = nextIndex;
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

    return {
        local_var_decl,
        nextIndex: lastIndex,
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
 * The final parse stage should match a set of statements - the highest-level concept of a method body.
 * 
 * Once the parse is complete, all the complete expressions in the body can be type-resolved and validated.
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
        : comment.replace(/./g, ' ')
    );

    const re = /(\s+)|(["'\d]|\.\d|\b(?:true|false|null|new)\b)|(\()|\b(if|switch|while|else|for|catch|case|default|do|try|finally|return|break|continue|throw)\b|(\w+|\d+(?:\.\d*)?[eE][+-]?\w*|[!~+-])|([;{}():])|(.)/g;
    for (let m, i; m = re.exec(text);) {
        if (m[i = 1]) {
            // ignore ws + comments
            continue;
        }
        //console.log(re.lastIndex, m[0])
        if (m[++i]) {
            // string, character, number, boolean, null or new - parse as an expression
            const { parsed, nextIndex } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, nextIndex - m.index, parsed));
            re.lastIndex = nextIndex;
            continue;
        }
        if (m[++i]) {
            // bracket - if the previous element was a branch keyword, tokenize it
            // otherwise parse it as an expression
            const prev = tokens.blocks[tokens.blocks.length - 1];
            if (prev && /if|for|while|switch|catch/.test(prev.source)) {
                tokens.blocks.push(TextBlock.from(text, m.index, m[0].length));
                continue;
            }
            const { parsed, nextIndex } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, nextIndex - m.index, parsed));
            re.lastIndex = nextIndex;
            continue;
        }
        if (m[++i]) {
            // statement keyword
            tokens.blocks.push(TextBlock.from(text, m.index, m[0].length));
            continue;
        }
        if (m[++i]) {
            // word - first check if this looks like a variable declaration
            //  if (layerType < LAYER_TYPE_NONE || layerType > LAYER_TYPE_HARDWARE) {
            const local_var_re1 = /(final +)?(\w+(?: *\. *\w+)*(?: *<(?:[a-zA-Z_]\w*|[<>\[\],.\s])*?>)?(?: *\[ *\])*)( +)(\w+)( *\[ *\])*/;
            const local_var_re = new RegExp(`(?<=^[\\d\\D]{${m.index}})${local_var_re1.source}`, 'g');
            //local_var_re.lastIndex = m.index;
            const local_var_match = local_var_re.exec(text);
            if (local_var_match && local_var_match.index === m.index && local_var_match[4] !== 'instanceof') {
                const { local_var_decl, nextIndex } = extractLocalVariableDeclaration(local_var_match, local_var_re.lastIndex, text, text_index);
                tokens.blocks.push(new LocalVariableDeclBlock(text, local_var_match.index, nextIndex, local_var_decl));
                re.lastIndex = nextIndex;
                continue;
            }
            const { parsed, nextIndex } = extractExpression(text, m.index);
            tokens.blocks.push(new ParsedExpressionBlock(text, m.index, nextIndex - m.index, parsed));
            re.lastIndex = nextIndex;
            continue;
        }
        if (m[++i]) {
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
        // for-iterables must match up to the ':' - otherwise, they're treated as normal for-loops
        /(for)(\()(Y)(:)(X?)(\)?)/g, // for-iterable -> G
        /(for)(\(?)([XY]?)(;?)(X?)(;?)(X?)(\)?)/g, // for -> F
        /(if)(\(?)(X?)(\)?)/g,         // if -> I
        /(while)(\(?)(X?)(\)?)/g,      // while -> W
        /(switch)(\(?)(X?)(\)?)/g,     // switch -> P
        /(catch)(\(?)(Y?)(\)?)/g,      // catch -> C
        /(case)(X?)(:?)/g,            // single case -> Q
        /(default)(:?)/g,             // default case -> Q
        /(return|break|continue|throw)(X?)(;?)/g, // return/break/continue -> S
        /(finally)/g,                 // finally block -> N
        /(else)/g,                    // else statement -> L
        /Y(;?)/g,                    // variable declaration -> V
        /X(;?)/g,                    // statement expression -> E
    ]

    let replacements = 'GFIWPCQQSNLVE';
    let ids = 'fit_hdr for_hdr if_hdr while_hdr switch_hdr catch case default rbct finally else localvar expr'.split(' ');
    chunks.forEach((re,idx) => {
        re.lastIndex = 0;
        for (let m; m = re.exec(sourcemap.simplified);) {
            let start = sourcemap.map[m.index];
            let end = sourcemap.map[m.index + m[0].length];
            tokens.shrink(ids[idx], start, end - start, m, replacements[idx], null, false);
            sourcemap = tokens.sourcemap();
            re.lastIndex = 0;
        }
    })

    chunks = [
        /\{([SBVE;]*)(\})/g,          // statement block -> B
        /I([SBVE;])(?!L)/g,             // if (Expression) Statement -> S
        /I([SBVE;])(L[SBVE;])/g,      // if (Expression) Statement/Block Else -> S
        /G[SBVE;]/g,                // for-iterable loop -> S
        /F[SBVE;]/g,                // for loop -> S
        /P(\{)(Q+[SBVE]*)*(\})/g,  // switch(Expression){ Q(caseblock),... } -> S
        /try(B)(CB?)?(NB?)?/g,          // try, Block, catch/finally -> S
        /do(B)(W?)(;?)/g,          // do Block While -> S
        /(?<!\})W[SVBE;]/g,          // While -> S - this needs the no-pre-brace check to allow do-while to pair correctly
    ]
    replacements = 'BSSSSSSSS';
    ids = 'block if ifelse fit for switch try dowhile while'.split(' ');
    for (let i=0; i < chunks.length; ) {
        let re = chunks[i];
        re.lastIndex = 0;
        let m = re.exec(sourcemap.simplified);
        if (m) {
            let start = sourcemap.map[m.index];
            let end = sourcemap.map[m.index + m[0].length];
            tokens.shrink(ids[i], start, end - start, m, replacements[i], null, false);
            sourcemap = tokens.sourcemap();
            i = 0;
            continue;
        }
        i++;
    }

    return tokens;

}

module.exports = {
    parseBody,
}
