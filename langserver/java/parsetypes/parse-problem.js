const ProblemSeverity = require('./problem-severity');
const { TextBlock } = require('./textblock');

/**
 * @typedef {import('./import')} ImportDeclaration
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./package')} PackageDeclaration
 * @typedef {import('./problem-severity').Severity} Severity
 */


class ParseProblem {
    /**
     * @param {TextBlock|TextBlock[]} token 
     * @param {string} message 
     * @param {Severity} severity 
     */
    constructor(token, message, severity) {
        if (Array.isArray(token)) {
            this.startIdx = token[0].range.start;
            const lastToken = token[token.length - 1];
            this.endIdx = lastToken.range.start + lastToken.range.length;
        } else {
            this.startIdx = token.range.start;
            this.endIdx = this.startIdx + token.range.length;
        }
        this.message = message;
        this.severity = severity;
    }

    /**
     * @param {TextBlock|TextBlock[]} token 
     * @param {string} message 
     */
    static Error(token, message) {
        return new ParseProblem(token, message, ProblemSeverity.Error);
    }

    /**
     * @param {TextBlock|TextBlock[]} token 
     * @param {string} message 
     */
    static Warning(token, message) {
        return new ParseProblem(token, message, ProblemSeverity.Warning);
    }

    /**
     * @param {TextBlock|TextBlock[]} token 
     * @param {string} message 
     */
    static Information(token, message) {
        return new ParseProblem(token, message, ProblemSeverity.Information);
    }

    /**
     * @param {TextBlock|TextBlock[]} token 
     * @param {string} message 
     */
    static Hint(token, message) {
        return new ParseProblem(token, message, ProblemSeverity.Hint);
    }

    /**
     * @param {TextBlock|TextBlock[]} token
     */
    static syntaxError(token) {
        if (!token) return null;
        return ParseProblem.Error(token, 'Unsupported, invalid or incomplete declaration');
    }
}

module.exports = ParseProblem;
