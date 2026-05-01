const { BUILT_IN_PROFILES, SUPPORTED_LANGUAGE } = require("../package-config");

function getSupportedDbs() {
  let supportedDbs = [];
  for(let profile of Object.keys(BUILT_IN_PROFILES)){
    supportedDbs.push(profile.replace(`${SUPPORTED_LANGUAGE}-`, ''))
  }
  return supportedDbs;
}

module.exports = {
  getSupportedDbs
};