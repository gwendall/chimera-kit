import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BRAND.origin, changeFrequency: "weekly", priority: 1 },
    { url: `${BRAND.origin}/docs`, changeFrequency: "weekly", priority: 0.8 },
  ];
}
