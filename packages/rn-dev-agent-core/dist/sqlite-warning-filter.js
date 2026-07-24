const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';
process.removeAllListeners('warning');
process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message === SQLITE_EXPERIMENTAL_WARNING) {
        return;
    }
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
export {};
