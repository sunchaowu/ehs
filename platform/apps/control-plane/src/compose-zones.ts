import { parse } from "yaml";

type Compose = { services?: Record<string, { networks?: string[]; ports?: string[] }> };

export function readZonePolicy(composeYaml: string): { publishedPorts: string[]; isolatedPairs: boolean } {
  const compose = parse(composeYaml) as Compose;
  const services = Object.values(compose.services ?? {});
  const publishedPorts = services.flatMap((service) => service.ports ?? []);
  const isolatedPairs = services.every((service) => {
    const networks = new Set(service.networks ?? []);
    const crosses = (left: string, right: string) => networks.has(left) && networks.has(right);
    return !crosses("test", "prod") && !crosses("test", "edge") && !crosses("prod", "edge");
  });
  return { publishedPorts, isolatedPairs };
}
