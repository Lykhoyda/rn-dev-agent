export function attachVerificationWarning(result, warning) {
    if (result.isError)
        return result;
    try {
        const text = result.content[0]?.text;
        if (!text)
            return result;
        const env = JSON.parse(text);
        env.meta = { ...env.meta, verification_warning: warning };
        return { content: [{ type: "text", text: JSON.stringify(env) }] };
    }
    catch {
        return result;
    }
}
