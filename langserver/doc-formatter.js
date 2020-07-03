/**
 * Convert JavaDoc content to markdown used by vscode.
 * 
 * This is a *very* rough conversion, simply looking for HTML tags and replacing them
 * with relevant markdown characters.
 * It is neither complete, nor perfect.
 * 
 * @param {string} header 
 * @param {string} documentation 
 * @returns {import('vscode-languageserver').MarkupContent}
 */
function formatDoc(header, documentation) {
    return {
        kind: 'markdown',
        value: `${header ? header + '\n\n' : ''}${
            (documentation || '')
            .replace(/(^\/\*+|(?<=\n)[ \t]*\*+\/?|\*+\/)/gm, '')
            .replace(/(\n[ \t]*@[a-z]+)|(<p(?: .*)?>)|(<\/?i>|<\/?em>)|(<\/?b>|<\/?strong>|<\/?dt>)|(<\/?tt>)|(<\/?code>|<\/?pre>|<\/?blockquote>)|(\{@link.+?\}|\{@code.+?\})|(<li>)|(<a href="\{@docRoot\}.*?">.+?<\/a>)|(<h\d>)|<\/?dd ?.*?>|<\/p ?.*?>|<\/h\d ?.*?>|<\/?div ?.*?>|<\/?[uo]l ?.*?>/gim, (_,prm,p,i,b,tt,c,lc,li,a,h) => {
                return prm ? `  ${prm}`
                : p ? '\n\n'
                : i ? '*'
                : b ? '**'
                : tt ? '`'
                : c ? '\n```'
                : lc ? lc.replace(/\{@\w+\s*(.+)\}/, (_,x) => `\`${x.trim()}\``)
                : li ? '\n- '
                : a ? a.replace(/.+?\{@docRoot\}(.*?)">(.+?)<\/a>/m, (_,p,t) => `[${t}](https://developer.android.com/${p})`)
                : h ? `\n${'#'.repeat(1 + parseInt(h.slice(2,-1),10))} `
                : '';
            })
        }`,
    };
}

exports.formatDoc = formatDoc;
