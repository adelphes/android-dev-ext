/**
 * @typedef {1|2|3|4} Severity
 * @type {{ Error:1, Warning:2, Information:3, Hint:4 }} 
 * these match the vscode DiagnosticSeverity values
*/
const ProblemSeverity = { Error:1, Warning:2, Information:3, Hint:4 };

module.exports = ProblemSeverity;
