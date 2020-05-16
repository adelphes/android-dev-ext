const Annotation = require('./parsetypes/annotation');
const Declaration = require('./parsetypes/declaration');
const FMCDeclaration = require('./parsetypes/fmc');
const ImportDeclaration = require('./parsetypes/import');
const PackageDeclaration = require('./parsetypes/package');
const ParameterDeclaration = require('./parsetypes/parameter');
const ParseProblem = require('./parsetypes/parse-problem');
const ParseResult = require('./parsetypes/parse-result');
const ParseSyntaxError = require('./parsetypes/parse-error');
const ProblemSeverity = require('./parsetypes/problem-severity');
const Token = require('./parsetypes/token');
const TypeDeclaration = require('./parsetypes/type');
const TypeIdent = require('./parsetypes/typeident');
const TypeParameters = require('./parsetypes/type-parameters');
/**
 * @typedef {import('./parsetypes/modifier')} Modifier
 */


 /**
  * @param {Token[]} tokens 
  * @param {number} idx 
  */
function findToken(tokens, idx) {
    return tokens.find(t => t.simplified_text_idx === idx);
}

/**
 * @param {string} simplified 
 * @param {number} lastIndex 
 */
function parseToBracketEnd(simplified, lastIndex) {
    // parse until close bracket
    let re = /[()]/g, balance = 1;
    const start = re.lastIndex = lastIndex;
    for (let m; m = re.exec(simplified);) {
        if (m[0] === '(') balance++;
        else if (--balance === 0) {
            re.lastIndex++;
            break;
        }
    }
    return {
        start,
        end: re.lastIndex,
    }
}

/**
 * @param {string} simplified 
 * @param {Token[]} tokens 
 * @param {{start: number, end: number}} simplified_range 
 * @param {*[]} invalids
 */
function parseParameters(simplified, tokens, simplified_range, invalids) {
    const decls = [
        /[ X]+/g,
        /@ *W( *\. *W)*( *\()?/g,
        /M/g,
        /W(?: *\. *W)*(?: *<.*?>)?(?: *\[ *\])*(?: +|( *\.\.\. *))W(?: *\[ *\])*( *,)?/g,  // parameter decl
        /(\)|$)/g, // end of params
    ];
    const parameters = [];
    /** @type {Modifier[]} */
    const modifiers = [];
    let lastIndex = simplified_range.start;
    for(;;) {
        /** @type {{idx:number, d: RegExp, m:RegExpMatchArray}} */
        let best_match = null, next_best = null;
        decls.find((d,idx) => {
            d.lastIndex = lastIndex;
            const m = d.exec(simplified);
            if (!m) return;
            if (m.index === lastIndex) {
                best_match = {idx, d, m};
                return true;
            }
            if (idx === 0) {
                return;
            }
            if (!next_best || m.index < next_best.m.index) {
                next_best = {idx, d, m};
            }
        });
        if (!best_match) {
            const errorToken = findToken(tokens, lastIndex);
            const error = new ParseSyntaxError(null, modifiers.splice(0), errorToken);
            invalids.push(error);
            best_match = next_best;
            if (!next_best) {
                break;
            }
        }

        lastIndex = best_match.d.lastIndex;

        if (best_match.idx === 1) {
            // annotation
            const at = findToken(tokens, best_match.m.index);
            const name = findToken(tokens, best_match.m.index + best_match.m[0].indexOf('W'));
            const annotation = new Annotation(at, name);
            modifiers.push(annotation);
            if (best_match.m[0].endsWith('(')) {
                lastIndex = parseToBracketEnd(simplified, lastIndex).end;
            }
        }
        else if (best_match.idx === 2) {
            // modifier
            const modifier = findToken(tokens, best_match.m.index);
            modifiers.push(modifier);
        }
        else if (best_match.idx === 3) {
            // parameter
            const name = findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf('W'));
            const varargs = best_match.m[1] ? findToken(tokens, best_match.m.index + best_match.m[0].indexOf('...')) : null;
            const comma = best_match.m[2] ? findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf(',')) : null;
            const typetokens = [];
            const first_type_token = findToken(tokens, best_match.m.index + best_match.m[0].indexOf('W'));
            for (let t = first_type_token, i = tokens.indexOf(t); t !== name; t = tokens[++i]) {
                if (t.simplified_text !== ' ')
                    typetokens.push(t);
            }
            const param = new ParameterDeclaration(modifiers.splice(0), new TypeIdent(typetokens), varargs, name, comma);
            parameters.push(param);
        } else if (best_match.idx === 4) {
            // end of parameters
            break;
        }
    }

    return parameters;
}

/**
 * @param {Token[]} typelist_tokens 
 */
function parseTypeIdentList(typelist_tokens) {
    // split the typelist into typetoken chunks, separated by commas
    let typeargs_balance = 0, array_balance = 0;
    /** @type {Token[][]} */
    let types = [[]];
    typelist_tokens.forEach(t => {
        switch(t.text) {
            case ' ':
                if (types[0].length === 0) {
                    return;
                }
                break;
            case ',':
                if (typeargs_balance <= 0 && array_balance <= 0) {
                    while (types[0][types[0].length - 1].text === ' ') {
                        types[0].pop();
                    }
                    typeargs_balance = array_balance = 0;
                    types.unshift([]);
                    return;
                }
                break;
            case '<':
                typeargs_balance++;
                break;
            case '>':
                typeargs_balance--;
                break;
            case ']':
                array_balance++;
                break;
            case '[':
                array_balance--;
                break;
        }
        types[0].push(t);
    });

    // remove any blank entries (start comma or sequential commas)
    return types.filter(t => t.length).reverse().map(tokens => new TypeIdent(tokens));
}

/**
 * @param {string} source 
 */
function parse(source) {
    const re = /(\/\*[\d\D]*?\*\/)|(\/\*)|(\*\/)|((?:\/\/.*)|(?:\s+))|(".*?")|('.'?)|\b(package|import|class|enum|interface|extends|implements|throws)\b|\b(public|private|protected|static|final|abstract|native|volatile|transient|synchronized|strictfp)\b|(\.{3}|[@{}()<>,;?*\[\].])|\b(super|new)\b|\b([A-Za-z_]\w*)|(\d[\w.]*)/g;

    let source_idx = 0, simplified_text_idx = 0;
    /** @type {Token[]} */
    let tokens = [];
    function mapSimplified(
        _,
        mlc,
        unterminated_mlc,
        mlc_end,
        slc_ws,
        string,
        char,
        decl_keyword,
        modifier,
        symbol,
        kw,
        word
        /* number, */
    ) {
        if (mlc) return 'X';//mlc.replace(/[^\n]+/g, '') || ' ';
        if (unterminated_mlc) return ' ';
        if (mlc_end) return ' ';
        if (slc_ws) return ' '; //slc_ws.replace(/[^\n]+/g, '').replace(/  +/,' ') || ' ';
        if (string) return 'S';
        if (char) return 'C';
        if (decl_keyword) return decl_keyword;
        if (modifier) return 'M';
        if (symbol) return symbol;
        if (kw) return kw;
        if (word) return 'W';
        return 'N';

    }
    const simplified = source.replace(re, (...args) => {
        let text = args[0];
        let next_idx = source.indexOf(text, source_idx);

        simplified_text_idx += (next_idx - source_idx);
        source_idx = next_idx;

        const simplified_text = mapSimplified.apply(null, args);
        tokens.push(new Token(source_idx, text, simplified_text, simplified_text_idx));

        source_idx += text.length;
        simplified_text_idx += simplified_text.length;

        return simplified_text;
    });

    // console.log(simplified);

     const decls = [
        / +/g,
        /package +W(?: *\. *W)*( *;)?/g,
        /import +(M +)?W(?: *\. *W)*( *\.\*)?( *;)?/g,
        /@ *W( *\. *W)*( *\()?/g,
        /M/g,
        /(class|enum|interface|@ *interface) +W(.+?(?= *[a-z{]))/g, // type declaration
        /(implements|extends|throws) +W(.+?(?= *[a-z{]))/g, // decl
        /W(?: *\. *W)*(?: *<.*?>)?(?: *\[ *\])* +W(?: *\[ *\])*( *[=;(,])?/g,  // field/method
        /W *\(/g,  // constructor
        /[{}]/g,  // scope
        /X/g,   // multi-line comment
        /<.*?>(?= *[WM@])/g,   // type variables
        /$/g, // end of file
    ]
    let lastIndex = 0;
    let loc = ['base'];
    let package_decl = null;
    let imports = [];
    let modifiers = [];
    let types = [];
    let invalids = [];
    let lastMLC = null;
    /** @type {TypeDeclaration[]} */
    let type_stack = [null];

    for(;;) {
        /** @type {{idx:number, d: RegExp, m:RegExpMatchArray}} */
        let best_match = null, next_best = null;
        decls.find((d,idx) => {
            d.lastIndex = lastIndex;
            const m = d.exec(simplified);
            if (!m) return;
            if (m.index === lastIndex) {
                best_match = {idx, d, m};
                return true;
            }
            if (idx === 0) {
                return;
            }
            if (!next_best || m.index < next_best.m.index) {
                next_best = {idx, d, m};
            }
        });
        if (!best_match) {
            const errorToken = findToken(tokens, lastIndex);
            const error = new ParseSyntaxError(lastMLC, modifiers.splice(0), errorToken);
            invalids.push(error);
            lastMLC = null;
            console.log(simplified.slice(lastIndex, lastIndex + 100));
            best_match = next_best;
            if (!next_best) {
                break;
            }
        }

        lastIndex = best_match.d.lastIndex;

        function parseToExpressionEnd() {
            // parse expression
            let re = /[(){};]/g, balance = [0,0];
            re.lastIndex = lastIndex;
            for (let m; m = re.exec(simplified);) {
                if (m[0] === '{') balance[0]++;
                else if (m[0] === '(') balance[1]++;
                else if (m[0] === '}') balance[0]--;
                else if (m[0] === ')') balance[1]--;
                else if (balance[0] <= 0 && balance[1] <= 0) {
                    break;
                }
            }
            // console.log(simplified.slice(lastIndex, re.lastIndex));
            lastIndex = re.lastIndex;
        }

        if (best_match.idx === 1) {
            // package - map all the name parts
            const nameparts = [];
            for (let m, re=/W/g; m = re.exec(best_match.m[0]); ) {
                const ident = findToken(tokens, best_match.m.index + m.index);
                nameparts.push(ident);
            }
            const semicolon = best_match.m[1] ? findToken(tokens, best_match.m.index + best_match.m[0].length - 1) : null;
            if (!package_decl) {
                package_decl = new PackageDeclaration(lastMLC, modifiers.splice(0), nameparts, semicolon);
            }
            lastMLC = null;
        }
        if (best_match.idx === 2) {
            // import - map all the name parts
            const nameparts = [];
            for (let m, re=/W/g; m = re.exec(best_match.m[0]); ) {
                const ident = findToken(tokens, best_match.m.index + m.index);
                nameparts.push(ident);
            }
            const static = best_match.m[1] ? findToken(tokens, best_match.m.index + best_match.m[0].indexOf('M')) : null;
            const asterisk = best_match.m[2] ? findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf('*')) : null
            const semicolon = best_match.m[3] ? findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf(';')) : null;
            let import_decl = new ImportDeclaration(lastMLC, modifiers.splice(0), nameparts, static, asterisk, semicolon);
            imports.push(import_decl);
            lastMLC = null;
        }
        if (best_match.idx === 3) {
            // annotation
            const at = findToken(tokens, best_match.m.index);
            const name = findToken(tokens, best_match.m.index + best_match.m[0].indexOf('W'));
            const annotation = new Annotation(at, name);
            modifiers.push(annotation);
            if (best_match.m[0].endsWith('(')) {
                lastIndex = parseToBracketEnd(simplified, lastIndex).end;
            }
        }
        if (best_match.idx === 4) {
            // modifier
            const modifier = findToken(tokens, best_match.m.index);
            modifiers.push(modifier);
        }

        if (best_match.idx === 5) {
            // type declaration
            const name = findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf('W'));
            /** @type {'class'|'interface'|'enum'|'@interface'} */
            // @ts-ignore
            const kind = best_match.m[1].replace(/ /g, '');
            const type = new TypeDeclaration(type_stack[0], lastMLC, modifiers.splice(0), kind, name);
            lastMLC = null;
            types.push(type);
            type_stack.unshift(type);
            loc.unshift('typedecl');
        }

        if (best_match.idx === 6) {
            // extends/implements/throws
            const decl_kw = findToken(tokens, best_match.m.index);
            const startidx = tokens.indexOf(findToken(tokens, best_match.m.index + best_match.m[0].indexOf('W')));
            const endidx = tokens.indexOf(findToken(tokens,best_match.m.index + best_match.m[0].length - 1));
            const typelist = parseTypeIdentList(tokens.slice(startidx, endidx + 1));
            switch(decl_kw.text) {
                case 'throws':
                    break;
                case 'extends':
                case 'implements':
                    if (loc[0] === 'typedecl') {
                        type_stack[0].super_declarations.push({ decl_kw, typelist });
                    }
            }
        }

        if (best_match.idx === 7) {
            // field or method
            const name = findToken(tokens, best_match.m.index + best_match.m[0].lastIndexOf('W'));
            const typetokens = [];
            for (let t = findToken(tokens, best_match.m.index), i = tokens.indexOf(t); t !== name; t = tokens[++i]) {
                if (t.simplified_text !== ' ')
                    typetokens.push(t);
            }
            let parameters, equals_comma_sc = null;
            switch (best_match.m[0].slice(-1)) {
                case '(':
                    // method
                    let params_source_range = parseToBracketEnd(simplified, lastIndex);
                    lastIndex = params_source_range.end;
                    parameters = parseParameters(simplified, tokens, params_source_range, invalids);
                    break;
                case '=':
                    // initialised field
                    equals_comma_sc = findToken(tokens, best_match.m.index + best_match.m[0].length);
                    parseToExpressionEnd();
                    break;
                case ',':
                    // multi-declaration field
                    equals_comma_sc = findToken(tokens, best_match.m.index + best_match.m[0].length);
                    throw new Error('not implemented');
                case ';':
                    // single field
                    equals_comma_sc = findToken(tokens, best_match.m.index + best_match.m[0].length);
                    break;
                default:
                    // invalid - but treat as a single field
                    break;
            }
            if (type_stack[0]) {
                const fmc = new FMCDeclaration(type_stack[0], lastMLC, modifiers.splice(0), best_match.m[0].endsWith('(') ? 'method' : 'field', name, new TypeIdent(typetokens), equals_comma_sc, parameters);
                type_stack[0].declarations.push(fmc);
            }
            lastMLC = null;
        }

        if (best_match.idx === 8) {
            // constructor (if the name matches the type)
            let params_source_range = parseToBracketEnd(simplified, lastIndex);
            lastIndex = params_source_range.end;
            const parameters = parseParameters(simplified, tokens, params_source_range, invalids);
            const name = findToken(tokens, best_match.m.index);
            if (type_stack[0] && name.text === type_stack[0].name.text) {
                const fmc = new FMCDeclaration(type_stack[0], lastMLC, modifiers.splice(0), 'constructor', name, null, null, parameters);
                type_stack[0].declarations.push(fmc);
            } else {
                invalids.push(new ParseSyntaxError(lastMLC, modifiers.splice(0), name));
            }
            lastMLC = null;
        }

        if (best_match.idx === 9) {
            // open/close scope
            if (best_match.m[0] === '{') {
                if (loc[0] === 'typedecl') loc[0] = 'typebody';
                else if (loc[0] === 'typebody') {
                    // static initer / method body
                    let re = /[{}]/g, balance = 1;
                    re.lastIndex = lastIndex;
                    for (let m; m = re.exec(simplified);) {
                        if (m[0] === '{') balance++;
                        else if (--balance === 0) {
                            re.lastIndex++;
                            break;
                        }
                    }
                    lastIndex = re.lastIndex;
                }
            } else {
                // end scope
                if (/^type/.test(loc[0])) {
                    loc.shift();
                    type_stack.shift();
                }
            }
        }

        if (best_match.idx === 10) {
            // mlc
            lastMLC = findToken(tokens, best_match.m.index);
        }

        if (best_match.idx === 11) {
            // type parameters
            const open = findToken(tokens, best_match.m.index);
            const close = findToken(tokens, best_match.m.index + best_match.m[0].length - 1);
            modifiers.push(new TypeParameters(open, close));
        }

        if (best_match.idx === 12) {
            // end of file
            break;
        }
    }

    return new ParseResult(package_decl, imports, types, invalids);
}

module.exports = {
    Annotation,
    Declaration,
    FMCDeclaration,
    ImportDeclaration,
    PackageDeclaration,
    parse,
    ParseProblem,
    ParseResult,
    ProblemSeverity,
    Token,
    TypeDeclaration,
    TypeParameters,
}
