const ProblemSeverity = require('./problem-severity');
const Token = require('./token');

/**
 * @typedef {import('./import')} ImportDeclaration
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./package')} PackageDeclaration
 * @typedef {import('./problem-severity').Severity} Severity
 */


class ParseProblem {
    /**
     * @param {Token|Token[]} token 
     * @param {string} message 
     * @param {Severity} severity 
     */
    constructor(token, message, severity) {
        this.startIdx = (Array.isArray(token) ? token[0] : token).source_idx;
        const lastToken = (Array.isArray(token) ? token[token.length - 1] : token);
        this.endIdx = lastToken.source_idx + lastToken.text.length;
        this.message = message;
        this.severity = severity;
    }

    /**
     * @param {Modifier[]} mods 
     */
    static checkDuplicateModifiers(mods) {
        const done = new Set();
        const res = [];
        for (let mod of mods) {
            if (mod instanceof Token) {
                if (done.has(mod.text)) {
                    res.push(new ParseProblem(mod, `Duplicate modifier: ${mod.text}`, ProblemSeverity.Error));
                }
                done.add(mod.text);
            }
        }
        return res;
    }

    static checkConflictingModifiers(mods) {
        const modmap = new Map();
        let res = [];
        mods.filter(m => m instanceof Token).forEach(m => modmap.set(m.text, m));
        const names = [...modmap.keys()];
        const visibilities = names.filter(m => /^(public|private|protected)$/.test(m));
        if (visibilities.length > 1) {
            const visnames = visibilities.map(m => `'${m}'`).join(', ').replace(/, (?='\w+'$)/, ' and ');
            res = visibilities.map(m => new ParseProblem(modmap.get(m), `Conflicting modifiers: ${visnames}`, ProblemSeverity.Error));
        }
        if (names.includes('abstract')) {
            if (names.includes('final')) {
                res.push(new ParseProblem(modmap.get('final'), `Declarations cannot be both 'abstract' and 'final`, ProblemSeverity.Error));
            }
            if (names.includes('native')) {
                res.push(new ParseProblem(modmap.get('native'), `Declarations cannot be both 'abstract' and 'native`, ProblemSeverity.Error));
            }
        }
        return res;
    }

    /**
     * @param {Modifier[]} mods 
     * @param {'class'|'interface'|'enum'|'@interface'|'field'|'method'|'constructor'|'initializer'} decl_kind
     */
    static checkAccessModifiers(mods, decl_kind) {
        let valid_mods = /^$/;
        switch (decl_kind) {
            case 'class': valid_mods = /^(public|final|abstract|strictfp)$/; break;
            case 'interface': valid_mods = /^(public|abstract|strictfp)$/; break;
            case '@interface': valid_mods = /^(public)$/; break;
            case 'enum': valid_mods = /^(public|final)$/; break;
            case 'field': valid_mods = /^(public|private|protected|static|final|volatile|transient)$/; break;
            case 'method': valid_mods = /^(public|private|protected|static|final|abstract|native|strictfp|synchronized)$/; break;
            case 'constructor': valid_mods = /^(public|protected|native)$/; break;
            case 'initializer': valid_mods = /^(static)$/; break;
        }
        const problems = [];
        for (let mod of mods) {
            if (mod instanceof Token) {
                if (!valid_mods.test(mod.text)) {
                    problems.push(new ParseProblem(mod, `'${mod.text}' is not a valid modifier for ${decl_kind} type declarations`, ProblemSeverity.Warning));
                }
                const redundant = (mod.text === 'abstract' && decl_kind === 'interface')
                    || (mod.text === 'final' && decl_kind === 'enum');
                if (redundant) {
                    problems.push(new ParseProblem(mod, `'${mod.text}' is redundant for a ${decl_kind} declaration`, ProblemSeverity.Hint));
                }
            }
        }
        return problems;
    }

    /**
     * @param {PackageDeclaration|ImportDeclaration} o 
     */
    static checkSemicolon(o) {
        if (!o.semicolon) {
            const lastToken = o.lastToken();
            return new ParseProblem(lastToken, 'Missing operator or semicolon',  ProblemSeverity.Error);
        }
    }

    /**
     * @param {Token[]} tokens 
     */
    static checkNonKeywordIdents(tokens) {
        const res = [];
        const KEYWORDS = /^(abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|throw|throws|transient|try|volatile|while)$/;
        const PRIMITIVE_TYPE_KEYWORDS = /^(int|boolean|byte|char|double|float|long|short|void)$/
        const LITERAL_VALUE_KEYWORDS = /^(this|true|false|null)$/;
        const OPERATOR_KEYWORDS = /^(instanceof)$/;
        for (let token of tokens) {
            let iskw = KEYWORDS.test(token.text) || PRIMITIVE_TYPE_KEYWORDS.test(token.text) || LITERAL_VALUE_KEYWORDS.test(token.text) || OPERATOR_KEYWORDS.test(token.text);
            if (iskw) {
                const problem = new ParseProblem(token, `'${token.text}' is a keyword and cannot be used as an identifier`,  ProblemSeverity.Error);
                res.push(problem);
            }
        }
        return res;
    }

    /**
     * @param {Token} token
     */
    static syntaxError(token) {
        if (!token) return null;
        return new ParseProblem(token, 'Unsupported, invalid or incomplete declaration', ProblemSeverity.Error);
    }
}

module.exports = ParseProblem;
