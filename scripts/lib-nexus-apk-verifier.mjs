import crypto from "node:crypto";

export const PLUGIN_ACTION = "com.anezium.rokidbus.action.PLUGIN";
export const META_PLUGIN_ID = "com.anezium.rokidbus.plugin.ID";
export const META_PLUGIN_API_VERSION = "com.anezium.rokidbus.plugin.API_VERSION";
export const META_PLUGIN_CAPABILITIES = "com.anezium.rokidbus.plugin.CAPABILITIES";

const MAIN_ACTION = "android.intent.action.MAIN";
const LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER";

function decodeAaptString(value) {
  const rawMatch = value.match(/\(Raw:\s*"((?:\\.|[^"\\])*)"\)/);
  const quotedMatch = value.match(/^"((?:\\.|[^"\\])*)"/);
  const encoded = (rawMatch || quotedMatch)?.[1];
  if (encoded == null) return null;
  try {
    return JSON.parse(`"${encoded}"`);
  } catch {
    return encoded;
  }
}

function parseAttribute(line) {
  const match = line.match(/^A:\s+(?:[^:()\s]+:)?([^()\s=]+)(?:\(0x[0-9a-f]+\))?=(.*)$/i);
  if (!match) return null;
  return { name: match[1], raw: match[2].trim() };
}

export function parseAaptXmlTree(output) {
  const roots = [];
  const stack = [];

  for (const sourceLine of String(output || "").split(/\r?\n/)) {
    const content = sourceLine.trimStart();
    const indent = sourceLine.length - content.length;
    const element = content.match(/^E:\s+([^\s(]+)/);
    if (element) {
      while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
      const node = { name: element[1], attributes: new Map(), children: [] };
      if (stack.length > 0) stack.at(-1).node.children.push(node);
      else roots.push(node);
      stack.push({ indent, node });
      continue;
    }

    if (!content.startsWith("A:") || stack.length === 0) continue;
    const attribute = parseAttribute(content);
    if (attribute) stack.at(-1).node.attributes.set(attribute.name, attribute.raw);
  }

  return roots;
}

function attributeString(node, name) {
  const raw = node?.attributes.get(name);
  return raw == null ? null : decodeAaptString(raw);
}

function attributeInteger(node, name) {
  const raw = node?.attributes.get(name);
  if (raw == null) return null;
  const text = decodeAaptString(raw);
  if (text != null && /^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  const typed = raw.match(/\(type\s+0x(?:10|11|12)\)(0x[0-9a-f]+|-?\d+)/i);
  if (!typed) return null;
  return Number.parseInt(typed[1], typed[1].toLowerCase().startsWith("0x") ? 16 : 10);
}

function attributeBoolean(node, name) {
  const raw = node?.attributes.get(name);
  if (raw == null) return false;
  const text = decodeAaptString(raw)?.toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  const value = attributeInteger(node, name);
  return value != null && value !== 0;
}

function children(node, name) {
  return (node?.children || []).filter((child) => child.name === name);
}

function intentFilterValues(component, elementName) {
  return children(component, "intent-filter").map((filter) => new Set(
    children(filter, elementName)
      .map((entry) => attributeString(entry, "name"))
      .filter(Boolean),
  ));
}

function serviceHasAction(service, action) {
  return intentFilterValues(service, "action").some((actions) => actions.has(action));
}

function metadataNode(service, key) {
  return children(service, "meta-data").find((metadata) => attributeString(metadata, "name") === key);
}

function metadataString(service, key) {
  return attributeString(metadataNode(service, key), "value");
}

function metadataInteger(service, key) {
  return attributeInteger(metadataNode(service, key), "value");
}

function splitMetadataList(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function error(field, message) {
  return { field, message };
}

export function validateManifestContract(xmltree, plugin) {
  const roots = parseAaptXmlTree(xmltree);
  const manifest = roots.find((node) => node.name === "manifest");
  const application = children(manifest, "application")[0];
  if (!application) {
    return [error("manifest.application", "APK manifest has no application element")];
  }

  const pluginServices = children(application, "service")
    .filter((service) => serviceHasAction(service, PLUGIN_ACTION));
  const exportedPluginServices = pluginServices
    .filter((service) => attributeBoolean(service, "exported"));
  if (exportedPluginServices.length !== 1) {
    return [error(
      "manifest.pluginService",
      `expected exactly one exported service with action ${PLUGIN_ACTION}, found ${exportedPluginServices.length}`,
    )];
  }

  const errors = [];
  const service = exportedPluginServices[0];
  const manifestPluginId = metadataString(service, META_PLUGIN_ID);
  if (manifestPluginId !== plugin.nexus.pluginId) {
    errors.push(error(
      "nexus.pluginId",
      `expected APK service metadata ${JSON.stringify(plugin.nexus.pluginId)}, found ${JSON.stringify(manifestPluginId)}`,
    ));
  }

  const manifestApiVersion = metadataInteger(service, META_PLUGIN_API_VERSION);
  if (manifestApiVersion !== 3) {
    errors.push(error(
      "nexus.apiVersion",
      `expected APK service metadata API version 3, found ${JSON.stringify(manifestApiVersion)}`,
    ));
  }

  const declaredCapabilities = new Set(splitMetadataList(
    metadataString(service, META_PLUGIN_CAPABILITIES),
  ));
  const missingCapabilities = plugin.nexus.capabilities
    .filter((capability) => !declaredCapabilities.has(capability));
  if (missingCapabilities.length > 0) {
    errors.push(error(
      "nexus.capabilities",
      `APK service metadata does not declare requested capabilities: ${missingCapabilities.join(", ")}`,
    ));
  }

  const launcherComponents = [
    ...children(application, "activity"),
    ...children(application, "activity-alias"),
  ].filter((activity) => {
    const filters = children(activity, "intent-filter");
    return filters.some((filter) => {
      const actions = new Set(children(filter, "action").map((entry) => attributeString(entry, "name")));
      const categories = new Set(children(filter, "category").map((entry) => attributeString(entry, "name")));
      return actions.has(MAIN_ACTION) && categories.has(LAUNCHER_CATEGORY);
    });
  });
  if (launcherComponents.length > 0) {
    errors.push(error(
      "manifest.activities",
      `headless plugins must not declare a MAIN/LAUNCHER activity; found ${launcherComponents.length}`,
    ));
  }

  return errors;
}

export function parseAaptBadging(output) {
  const match = String(output || "").match(
    /^package:\s+name='([^']+)'(?:\s+versionCode='([^']+)')?(?:\s+versionName='([^']*)')?/m,
  );
  if (!match) {
    throw new Error("aapt dump badging did not report package metadata");
  }
  return {
    packageName: match[1],
    versionCode: match[2] ? Number.parseInt(match[2], 10) : null,
    versionName: match[3] ?? null,
  };
}

export function measuredArtifact(bytes, badging, signerSha256) {
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    signerSha256,
    sizeBytes: bytes.length,
    ...badging,
  };
}

export function compareArtifactMetadata(expected, actual, fields = [
  "sha256", "signerSha256", "sizeBytes", "packageName", "versionCode", "versionName",
]) {
  const errors = [];
  for (const field of fields) {
    const expectedValue = field === "sha256" && typeof expected[field] === "string"
      ? expected[field].toLowerCase()
      : expected[field];
    if (expectedValue !== actual[field]) {
      errors.push(error(
        `artifact.${field}`,
        `expected ${JSON.stringify(expected[field])}, APK contains ${JSON.stringify(actual[field])}`,
      ));
    }
  }
  return errors;
}
