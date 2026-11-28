const labels = { maven: 'Maven', gradle: 'Gradle', sbt: 'sbt' };

export function buildProfileDetails(id) {
    const match = /^(maven|gradle|sbt)-java(17|25)-v1$/u.exec(id);
    if (!match) throw new Error('BUILD_PROFILE_UNSUPPORTED');
    const [, tool, java] = match;
    // The pinned technical foundation uses Java 17 IDs for the same model queries.
    return { tool, java, modelId: `${tool}-java17-v1`, label: `${labels[tool]} · Java ${java}` };
}

export function submissionProfiles(ids) {
    return ids.flatMap(id => {
        const { tool, modelId } = buildProfileDetails(id);
        return [`${tool}-java25-v1`, modelId];
    });
}
