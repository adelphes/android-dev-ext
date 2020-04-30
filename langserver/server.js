const fs = require('fs');
const {
    createConnection,
    TextDocuments,
    //TextDocument,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    //InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentSyncKind,
    //TextDocumentPositionParams
  } = require('vscode-languageserver');
  
  const { TextDocument } = require('vscode-languageserver-textdocument');

  const MTI = require('./java/mti');
  let androidLibrary = null;
  function loadAndroidLibrary(retry) {
    try {
      androidLibrary = MTI.unpackJSON('/tmp/jarscanner/android-25/android-25.json');
      connection.console.log(`Android type cache loaded: ${androidLibrary.types.length} types from ${androidLibrary.packages.length} packages.`);
    } catch (e) {
      connection.console.log(`Failed to load android type cache`);
      if (retry) {
        return;
      }
      connection.console.log(`Rebuilding type cache...`);
      const jarscanner = require(`jarscanner/jarscanner`);
      fs.mkdir('/tmp/jarscanner', err => {
        if (err) {
          connection.console.log(`Cannot create type cache folder. ${err.message}.`);
          return
        }
        jarscanner.process_android_sdk_source({
          destpath: '/tmp/jarscanner',
          sdkpath: process.env['ANDROID_SDK'],
          api: 25,
          cleandest: true,
        }, (err) => {
          if (err) {
            connection.console.log(`Android cache build failed. ${err.message}.`);
            return
          }
          loadAndroidLibrary(true);
        })
      })
    }
  }

  // Create a connection for the server. The connection uses Node's IPC as a transport.
  // Also include all preview / proposed LSP features.
  let connection = createConnection(ProposedFeatures.all);
  
  // Create a simple text document manager. The text document manager
  // supports full document sync only
  let documents = new TextDocuments({
    /**
     * 
     * @param {string} uri 
     * @param {string} languageId 
     * @param {number} version 
     * @param {string} content 
     */
    create(uri, languageId, version, content) {
      connection.console.log(JSON.stringify({what:'create',uri,languageId,version,content}));
    },
    /**
     * 
     * @param {*} document 
     * @param {import('vscode-languageserver').TextDocumentContentChangeEvent[]} changes 
     * @param {number} version 
     */
    update(document, changes, version) {
      connection.console.log(JSON.stringify({what:'update',changes,version}));
    }

  });
  
  let hasConfigurationCapability = false;
  let hasWorkspaceFolderCapability = false;
  let hasDiagnosticRelatedInformationCapability = false;
  
  connection.onInitialize((params) => {
    process.nextTick(loadAndroidLibrary);
    let capabilities = params.capabilities;
  
    // Does the client support the `workspace/configuration` request?
    // If not, we will fall back using global settings
    hasConfigurationCapability =
      capabilities.workspace && !!capabilities.workspace.configuration;

    hasWorkspaceFolderCapability =
      capabilities.workspace && !!capabilities.workspace.workspaceFolders;

    hasDiagnosticRelatedInformationCapability =
      capabilities.textDocument &&
      capabilities.textDocument.publishDiagnostics &&
      capabilities.textDocument.publishDiagnostics.relatedInformation;
  
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        // Tell the client that the server supports code completion
        completionProvider: {
          resolveProvider: true
        }
      }
    };
  });
  
  connection.onInitialized(() => {
    if (hasConfigurationCapability) {
      // Register for all configuration changes.
      connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders(_event => {
        connection.console.log('Workspace folder change event received.');
      });
    }
  });
  
  // The example settings
  /**
   * @typedef ExampleSettings
   * @property {number} maxNumberOfProblems
   */
  
  // The global settings, used when the `workspace/configuration` request is not supported by the client.
  // Please note that this is not the case when using this server with the client provided in this example
  // but could happen with other clients.
  const defaultSettings = { maxNumberOfProblems: 1000 };
  let globalSettings = defaultSettings;
  
  // Cache the settings of all open documents
  /** @type {Map<string, Thenable<ExampleSettings>>} */
  let documentSettings = new Map();
  
  connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
      // Reset all cached document settings
      documentSettings.clear();
    } else {
      globalSettings = (
        (change.settings.androidJavaLanguageServer || defaultSettings)
      );
    }
  
    // Revalidate all open text documents
    documents.all().forEach(validateTextDocument);
  });
  
  function getDocumentSettings(resource) {
    if (!hasConfigurationCapability) {
      return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
      result = connection.workspace.getConfiguration({
        scopeUri: resource,
        section: 'androidJavaLanguageServer'
      });
      documentSettings.set(resource, result);
    }
    return result;
  }
  
  // Only keep settings for open documents
  documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
  });
  
  // The content of a text document has changed. This event is emitted
  // when the text document first opened or when its content has changed.
  // documents.onDidChangeContent(change => {
  //   connection.console.log(JSON.stringify(change));
    //validateTextDocument(change.document);
  // });
  
  /**
   * @param {TextDocument} textDocument 
   */
  async function validateTextDocument(textDocument) {
    // In this simple example we get the settings for every validate run.
    //let settings = await getDocumentSettings(textDocument.uri);
  
    // The validator creates diagnostics for all uppercase words length 2 and more
    let text = textDocument.getText();
    let pattern = /\b[A-Z]{2,}\b/g;
    let m;
  
    let problems = 0;
    let diagnostics = [];
    while ((m = pattern.exec(text)) /* && problems < settings.maxNumberOfProblems */) {
      problems++;
      /** @type {Diagnostic} */
      let diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: textDocument.positionAt(m.index),
          end: textDocument.positionAt(m.index + m[0].length)
        },
        message: `${m[0]} is all uppercase.`,
        source: 'ex'
      };
      if (hasDiagnosticRelatedInformationCapability) {
        diagnostic.relatedInformation = [
          {
            location: {
              uri: textDocument.uri,
              range: Object.assign({}, diagnostic.range)
            },
            message: 'Spelling matters'
          },
          {
            location: {
              uri: textDocument.uri,
              range: Object.assign({}, diagnostic.range)
            },
            message: 'Particularly for names'
          }
        ];
      }
      diagnostics.push(diagnostic);
    }
  
    // Send the computed diagnostics to VS Code.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  }
  
  connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VS Code
    connection.console.log('We received a file change event');
  });
  
  // This handler provides the initial list of the completion items.
  let allCompletionTypes = null;
  connection.onCompletion(
      /**
       * @param {*} _textDocumentPosition TextDocumentPositionParams
       */
    (_textDocumentPosition) => {
      // The pass parameter contains the position of the text document in
      // which code complete got requested. For the example we ignore this
      // info and always provide the same completion items.
      const lib = androidLibrary;
      if (!lib) return [];
      const typeKindMap = {
          'class':CompletionItemKind.Class,
          'interface': CompletionItemKind.Interface,
          '@interface': CompletionItemKind.Interface,
          'enum': CompletionItemKind.Enum,
        };
      return allCompletionTypes || (allCompletionTypes = lib.types.map((t,idx) =>
          /** @type {CompletionItem} */
        ({
            label: t.dottedRawName,
            kind: typeKindMap[t.typeKind],
            data: idx
          })
      ));
      return [
        {
          label: 'TypeScript',
          kind: CompletionItemKind.Text,
          data: 1
        },
        {
          label: 'JavaScript',
          kind: CompletionItemKind.Text,
          data: 2
        }
      ];
    }
  );
  
  // This handler resolves additional information for the item selected in
  // the completion list.
  connection.onCompletionResolve(
    /**
     * @param {CompletionItem} item
     */
    (item) => {
       const t = androidLibrary.types[item.data];
      item.detail = `${t.package}.${t.dottedRawName}`;
      item.documentation = t.docs && {
          kind: "markdown",
          value: `${t.typeKind} **${t.dottedName}**\n\n${
              t.docs
              .replace(/(<p ?.*?>)|(<\/?i>|<\/?em>)|(<\/?b>|<\/?strong>|<\/?dt>)|(<\/?tt>)|(<\/?code>|<\/?pre>)|(\{@link.+?\}|\{@code.+?\})|(<li>)|(<a href="\{@docRoot\}.*?">.+?<\/a>)|(<h\d>)|<\/?dd ?.*?>|<\/p ?.*?>|<\/h\d ?.*?>|<\/?div ?.*?>|<\/?[uo]l ?.*?>/gim, (_,p,i,b,tt,c,lc,li,a,h) => {
                  return p ? '\n\n' 
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
      }
      return item;
    }
  );
  
  /*
  connection.onDidOpenTextDocument((params) => {
      // A text document got opened in VS Code.
      // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
      // params.text the initial full content of the document.
      connection.console.log(`${params.textDocument.uri} opened.`);
  });
  connection.onDidChangeTextDocument((params) => {
      // The content of a text document did change in VS Code.
      // params.uri uniquely identifies the document.
      // params.contentChanges describe the content changes to the document.
      connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
  });
  connection.onDidCloseTextDocument((params) => {
      // A text document got closed in VS Code.
      // params.uri uniquely identifies the document.
      connection.console.log(`${params.textDocument.uri} closed.`);
  });
  */
  
  // Make the text document manager listen on the connection
  // for open, change and close text document events
  documents.listen(connection);
  
  // Listen on the connection
  connection.listen();
  