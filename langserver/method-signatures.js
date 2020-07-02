const { Method } = require('java-mti');
const { indexAt } = require('./document');
const { formatDoc } = require('./doc-formatter');
const { trace } = require('./logging');
const { event } = require('./analytics');

let methodsigRequestCount = 0;

/**
 * Retrieve method signature information
 * 
 * Each parsed token that is relevant to a method call is 
 * tagged with the list of possible methods and the best matched
 * method. The tagged tokens include:
 * - the opening bracket
 * - each token in every argument
 * - each comma between the arguments
 * 
 * The function locates the nearest non-ws token and checks
 * for any tagged method-call info. It then converts it
 * to the relevant vscode method signature structure for display.
 * 
 * @param {import('vscode-languageserver').SignatureHelpParams} request
 * @param {Map<string,import('./document').JavaDocInfo>} liveParsers
 */
async function getSignatureHelp(request, liveParsers) {
    trace('getSignatureHelp');
    /** @type {import('vscode-languageserver').SignatureHelp} */
    let sighelp = {
        signatures: [],
        activeSignature: 0,
        activeParameter: 0,
    }
    const docinfo = liveParsers.get(request.textDocument.uri);
    if (!docinfo || !docinfo.parsed) {
        return sighelp;
    }

    // wait for any active edits to complete
    await docinfo.reparseWaiter;

    methodsigRequestCount += 1;
    if ((methodsigRequestCount === 1) || (methodsigRequestCount === 5) || ((methodsigRequestCount % 25) === 0)) {
        event('method-sig-requests', { methsig_req_count: methodsigRequestCount });
    }

    // locate the token at the requested position
    const index = indexAt(request.position, docinfo.content);
    const token = docinfo.parsed.unit.getTokenAt(index);
    if (!token || !token.methodCallInfo) {
        trace('onSignatureHelp - no method call info');
        return sighelp;
    }

    // the token has method information attached to it
    // - convert it to the required vscode format
    trace(`onSignatureHelp - ${token.methodCallInfo.methods.length} methods`);
    sighelp = {
        signatures: token.methodCallInfo.methods.map(m => {
            const documentation = formatDoc(`#### ${m.owner.simpleTypeName}${m instanceof Method ? `.${m.name}` : ''}()`, m.docs);
            const param_docs = new Map();
            if (documentation) {
                // extract each of the @param sections (if any)
                for (let m, re=/@param\s+(\S+)([\d\D]+?)(?=\n\n|\n[ \t*]*@\w+|$)/g; m = re.exec(documentation.value);) {
                    param_docs.set(m[1], m[2]);
                }
            }
            /** @type {import('vscode-languageserver').SignatureInformation} */
            let si = {
                label: m.label,
                documentation,
                parameters: m.parameters.map(p => {
                    /** @type {import('vscode-languageserver').ParameterInformation} */
                    let pi = {
                        documentation: {
                            kind: 'markdown',
                            value: param_docs.has(p.name) ? `**${p.name}**: ${param_docs.get(p.name)}` : '',
                        },
                        label: p.label
                    }
                    return pi;
                })
            }
            return si;
        }),
        activeSignature: token.methodCallInfo.methodIdx,
        activeParameter: token.methodCallInfo.argIdx,
    }
    return sighelp;
}

exports.getSignatureHelp = getSignatureHelp;
