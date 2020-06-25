const { TextBlock, BlockRange } = require('./parsetypes/textblock');

/**
 * Convert a token to its simplified form for easier declaration parsing.
 * 
 * - Whitespace, comments, strings and character literals are normalised.
 * - Modifier keywords and identifers are abbreviated.
 * - Any invalid text is replaced with spaces.
 * 
 * Abbreviated and normalised values are padded to occupy the same space 
 * as the original text - this ensures any parse errors are reported in the
 * correct location.
 * @param {string} text 
 * @param {number} start 
 * @param {number} length 
 * @param {string} kind 
 */
function tokenKindToSimplified(text, start, length, kind) {
    const chunk = text.slice(start, start + length);
    switch (kind) {
        case 'wsc':
            return chunk.replace(/[^\r\n]/g, ' ');
        case 'string-literal':
            if (chunk.length <= 2) return chunk;
            return `"${'#'.repeat(chunk.length - 2)}"`;
        case 'char-literal':
            if (chunk.length <= 2) return chunk;
            return `'${'#'.repeat(chunk.length - 2)}'`;
        case 'primitive-type':
            return `P${' '.repeat(chunk.length - 1)}`;
        case 'modifier':
            return `M${' '.repeat(chunk.length - 1)}`;
        case 'ident':
            return `W${' '.repeat(chunk.length - 1)}`;
        case 'invalid':
            return ' '.repeat(chunk.length);
    }
    return chunk;
}

class Token extends TextBlock {

    /**
     * @param {string} text 
     * @param {number} start 
     * @param {number} length 
     * @param {string} kind 
     */
    constructor(text, start, length, kind) {
        super(new BlockRange(text, start, length), tokenKindToSimplified(text, start, length, kind));
        this.kind = kind;
        /** @type {{key:string}} */
        this.loc = null;
    }

    get value() {
        return this.source;
    }
}


/**
 *   \s+       whitespace
 *   \/\/.*    single-line comment (slc)
 *   \/\*[\d\D]*?\*\/   multi-line comment (mlc)
 *   "[^\r\n\\"]*(?:\\.[^\r\n\\"]*)*"   string literal - correctly terminated but may contain invalid escapes
 *   ".*       unterminated string literal
 *   '\\?.?'?  character literal - possibly unterminated and/or with invalid escape
 *   \.?\d     number literal (start) - further processing extracts the value
 *   [\p{L}\p{N}_$]*       word - keyword or identifier
 *   [;,?:(){}\[\]]   single-character symbols and operators
 *   \.(\.\.)?    . ...
 * 
 *   the operators: [!=/%*^]=?|<<?=?|>>?[>=]?|&[&=]?|\|[|=]?|\+(=|\++)?|\-+=?
 *   [!=/%*^]=?   ! = / % * ^ != == /= %= *= ^= 
 *   <<?=?        < << <= <<=
 *   >>?[>=]?     > >> >= >>> >>=
 *   &[&=]?       & && &=
 *   \|[|=]?      | || |=
 *   (\+\+|--)     ++ --   postfix inc - only matches if immediately preceded by a word or a ]
 *   [+-]=?       + - += -=
 * 
 * 
 * 
 */

/**
 * 
 * @param {string} source 
 * @param {number} [offset] 
 * @param {number} [length] 
 */
function tokenize(source, offset = 0, length = source.length) {
    const text = source.slice(offset, offset + length);
    const raw_token_re = /(\s+|\/\/.*|\/\*[\d\D]*?\*\/|\/\*[\d\D]*)|("[^\r\n\\"]*(?:\\.[^\r\n\\"]*)*"|".*)|('\\u[\da-fA-F]{0,4}'?|'\\?.?'?)|(\.?\d)|([\p{L}\p{N}$_]+)|(\()|([;,?:(){}\[\]@]|\.(?:\.\.)?)|([!=/%*^]=?|<<?=?|>>?>?=?|&[&=]?|\|[|=]?|(\+\+|--)|->|[+-]=?|~)|$/gu;
    const raw_token_types = [
        'wsc',
        'string-literal',
        'char-literal',
        'number-literal',
        'word',
        'open-bracket',
        'symbol',
        'operator',
    ];
    /**
     * Note that some keywords have context-dependant meanings:
     *   default - modifier or statement-keyword
     *   synchronized - modifier or statement-keyword
     * They are treated as modifiers and updated with their new token-type when method bodies are parsed
     * 
     * ```
     * true|false    boolean
     * this|null     object
     * int|long|short|byte|float|double|char|boolean|void   primitive type
     * new
     * instanceof
     * public|private|protected|static|final|abstract|native|volatile|transient|default|synchronized   modifier
     * if|else|while|for|do|try|catch|finally|switch|case|return|break|continue|throw    statement keyword
     * class|enum|interface    type keyword
     * package|import    package keyword
     * \w+    word
     * ```
     */
    const word_re = /^(?:(true|false)|(this|super|null)|(int|long|short|byte|float|double|char|boolean|void)|(new)|(instanceof)|(public|private|protected|static|final|abstract|native|volatile|transient|strictfp|default|synchronized)|(if|else|while|for|do|try|catch|finally|switch|case|return|break|continue|throw|assert)|(class|enum|interface)|(extends|implements|throws)|(package|import)|(.+))$/;

    const word_token_types = [
        'boolean-literal',
        'object-literal',
        'primitive-type',
        'new-operator',
        'instanceof-operator',
        'modifier',
        'statement-kw',
        'type-kw',
        'package-kw',
        'eit-kw',
        'ident'
    ]
    /**
     * ```
     * \d+(?:\.?\d*)?|\.\d+)[eE][+-]?\d*[fFdD]?    decimal exponent: 1e0, 1.5e+10, 0.123E-20d
     * (?:\d+\.\d*|\.\d+)[fFdD]?    decimal number: 0.1, 12.34f, 7.D, .3
     * 0[xX][\da-fA-F]*\.[\da-fA-F]*[pP][+-]?\d*[fFdD]?    hex exponent: 0x123.abcP-100
     * 0x[\da-fA-F]*[lL]?    hex integer: 0x1, 0xaBc, 0x, 0x7L
     * \d+[fFdDlL]?   integer: 0, 123, 234f, 345L
     * ```
     * todo - underscore seperators
     */
    const number_re = /((?:\d+(?:\.?\d*)?|\.\d+)[eE][+-]?\d*[fFdD]?)|((?:\d+\.\d*|\.\d+)[fFdD]?)|(0[xX][\da-fA-F]*\.[\da-fA-F]*[pP][+-]?\d*[fFdD]?)|(0[xX][\da-fA-F]*[lL]?)|(\d+[fFdDlL]?)/g;
    const number_token_types = [
        'dec-exp-number-literal',
        'dec-number-literal',
        'hex-exp-number-literal',
        'hex-number-literal',
        'int-number-literal',
    ]
    const tokens = [];
    let lastindex = 0, m;
    while (m = raw_token_re.exec(text)) {
        // any text appearing between two matches is invalid
        if (m.index > lastindex) {
            tokens.push(new Token(source, offset + lastindex, m.index - lastindex, 'invalid'));
        }
        lastindex = m.index + m[0].length;
        if (m.index >= text.length) {
            // end of input
            break;
        }

        let idx = m.findIndex((match,i) => i && match) - 1;
        let tokentype = raw_token_types[idx];

        switch(tokentype) {
            case 'number-literal':
                // we need to extract the exact number part
                number_re.lastIndex = m.index;
                m = number_re.exec(text);
                idx = m.findIndex((match,i) => i && match) - 1;
                tokentype = number_token_types[idx];        
                // update the raw_token_re position based on the length of the extracted number
                raw_token_re.lastIndex = lastindex = number_re.lastIndex;
                break;
            case 'word':
                // we need to work out what kind of keyword, literal or ident this is
                let word_m = m[0].match(word_re);
                idx = word_m.findIndex((match,i) => i && match) - 1;
                tokentype = word_token_types[idx];        
                break;
            case 'operator':
                // find the operator-type
                tokentype = getOperatorType(m[0]);
                break;
        }
        tokens.push(new Token(source, offset + m.index, m[0].length, tokentype));
    }
    
    return tokens;
}


/**
 * ```
 * =|[/%*&|^+-]=|>>>?=|<<=    assignment
 * \+\+|--   inc
 * [!=]=     equality
 * [<>]=?    comparison
 * [&|^]    bitwise
 * <<|>>>?    shift
 * &&|[|][|]   logical
 * [*%/]   muldiv
 * [+-]   plumin
 * [~!]   unary
 * ```
 */
const operator_re = /^(?:(=|[/%*&|^+-]=|>>>?=|<<=)|(\+\+|--)|([!=]=)|([<>]=?)|([&|^])|(<<|>>>?)|(&&|[|][|])|([*%/])|(->)|([+-])|([~!]))$/;
/**
 * @typedef {
    'assignment-operator'|
    'inc-operator'|
    'equality-operator'|
    'comparison-operator'|
    'bitwise-operator'|
    'shift-operator'|
    'logical-operator'|
    'muldiv-operator'|
    'lambda-operator'|
    'plumin-operator'|
    'unary-operator'} OperatorKind
 */
/** @type {OperatorKind[]} */
const operator_token_types = [
    'assignment-operator',
    'inc-operator',
    'equality-operator',
    'comparison-operator',
    'bitwise-operator',
    'shift-operator',
    'logical-operator',
    'muldiv-operator',
    'lambda-operator',
    'plumin-operator',
    'unary-operator',
]
/**
 * @param {string} value 
 */
function getOperatorType(value) {
    const op_match = value.match(operator_re);
    const idx = op_match.findIndex((match,i) => i && match) - 1;
    // @ts-ignore
    return operator_token_types[idx];
}


exports.getOperatorType = getOperatorType;
exports.tokenize = tokenize;
exports.Token = Token;
