import baseConfig from '../../ai-config.json';

const hydrate = (config) => {
    const { personName, pronouns } = config;
    const replace = (str) => {
        if (typeof str !== 'string') return str;
        return str
            .replace(/{{NAME}}/g, personName)
            .replace(/{{SUBJECT}}/g, pronouns.subject)
            .replace(/{{OBJECT}}/g, pronouns.object)
            .replace(/{{POSSESSIVE}}/g, pronouns.possessive);
    };

    const hydrated = { ...config };
    Object.keys(hydrated).forEach((key) => {
        if (typeof hydrated[key] === 'string') {
            hydrated[key] = replace(hydrated[key]);
        }
    });
    return hydrated;
};

const config = hydrate(baseConfig);
export default config;
