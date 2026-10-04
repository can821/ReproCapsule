const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const sections = report => [
  ['Failure definition',{command:report.command,predicate:report.failurePredicate,signature:report.failureSignature}],
  ['Environment',report.environment],['Reduction',report.reduction],['Dependencies',report.dependencies],['Workspaces',report.workspaces],
  ['Input',report.inputReduction],['Why items remain',report.explanations],['Minimality',report.minimality],['Suspicious locations',report.diagnostics],
  ['Integrity',report.integrity],['Limitations',report.limitations],
];
export default {
  apiVersion:1,name:'builtin',formats:['html','markdown'],
  render(report,{format}) {
    if(format==='markdown')return '# ReproCapsule evidence report\n\n'+sections(report).map(([title,value])=>`## ${title}\n\n\`\`\`json\n${JSON.stringify(value,null,2).replaceAll('`','\\u0060')}\n\`\`\`\n`).join('\n');
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><meta name="viewport" content="width=device-width"><title>ReproCapsule evidence</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#18212b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:16px}h2{margin-top:32px}</style><body><h1>ReproCapsule evidence report</h1><p>Local integrity inspection only; this report does not rerun the reproduction command.</p>'+sections(report).map(([title,value])=>`<section><h2>${escape(title)}</h2><pre>${escape(JSON.stringify(value,null,2))}</pre></section>`).join('')+'</body></html>\n';
  },
};
