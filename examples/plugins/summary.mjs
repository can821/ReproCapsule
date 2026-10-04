// Explicitly loaded local code: --plugin examples/plugins/summary.mjs --format json
export default {
  apiVersion:1,name:'example-summary',formats:['json'],
  render(report) {
    return JSON.stringify({schemaVersion:report.schemaVersion,files:{before:report.reduction.originalFileCount,after:report.reduction.finalFileCount},integrity:report.integrity.status},null,2)+'\n';
  },
};
