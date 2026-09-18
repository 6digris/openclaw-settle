// npm can accept an incomplete shrinkwrap without installing every declared
// dependency. Compare with the manifest independently of regeneration or smoke imports.
export function assertDeclaredShrinkwrapDependencies(shrinkwrap, packageJson) {
  const packages = shrinkwrap?.packages ?? {};
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    if (!packages[""]?.dependencies?.[name] || !packages[`node_modules/${name}`]?.version) {
      throw new Error(`npm-shrinkwrap.json is missing declared dependency ${name}`);
    }
  }
}
