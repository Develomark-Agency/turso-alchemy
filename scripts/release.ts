import { $ } from "bun";
import packageJson from "../package.json";

async function getVersions() {
  const versions = await $`gh release list --json name,tagName,publishedAt,isLatest`.quiet().json() as { isLatest: boolean, name: string, publishedAt: string, tagName: string }[];

  return versions.map(version => ({
    ...version,
    publishedAt: new Date(version.publishedAt)
  }));
}

async function pack() {
  await $`bun run build`;
  await $`bun pm pack --destination dist`.quiet();
  const p = `./dist/${packageJson.name}-${packageJson.version}.tgz`;
  const release = Bun.file(p);

  const success = await release.exists();
  if(!success) throw new Error("Error packing release");

  return p;
}

async function release(path: string) {
  await $`gh release create "${packageJson.version}" --title "${packageJson.name} v${packageJson.version}" --notes "" ${path}`;
}

const existingVersions = await getVersions();

if(existingVersions.some(v => v.tagName === packageJson.version)) {
  throw new Error(`A release with version ${packageJson.version} already exists. Either increment the version in ./package.json, or delete the existing release.`);
}

const packPath = await pack();

await release(packPath);
