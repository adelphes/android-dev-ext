const { Method } = require('java-mti');
const { indexAt } = require('./document');
const { formatDoc } = require('./doc-formatter');
const { trace } = require('./logging');

/**
 * @param {import('vscode-languageserver').SignatureHelpParams} request
 * @param {*} liveParsers
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
    await docinfo.reparseWaiter;
    const index = indexAt(request.position, docinfo.content);
    const token = docinfo.parsed.unit.getTokenAt(index);
    if (!token || !token.methodCallInfo) {
        trace('onSignatureHelp - no method call info');
        return sighelp;
    }
    trace(`onSignatureHelp - ${token.methodCallInfo.methods.length} methods`);
    sighelp = {
        signatures: token.methodCallInfo.methods.map(m => {
            const documentation = formatDoc(`#### ${m.owner.simpleTypeName}${m instanceof Method ? `.${m.name}` : ''}()`, m.docs);
            const param_docs = new Map();
            if (documentation) {
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
