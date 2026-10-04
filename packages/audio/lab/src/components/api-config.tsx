import { Button, Input, Tag } from "@parrot-co/parrot-ui";
import { useState } from "react";
import { Card, SectionHeader } from "./card";
import { readApiConfig, writeApiConfig } from "@/lib/api";

/**
 * Speak and transcribe are subject-authed; the lab has no session. The
 * developer supplies the base URL and a token — the same seam as the SDK's
 * `mint()` — and everything that needs the API switches on.
 */
export function ApiConfigCard({ onChange }: { onChange?: () => void }) {
  const current = readApiConfig();
  const [url, setUrl] = useState(current?.url ?? import.meta.env.VITE_PATCHWORK_URL ?? "");
  const [token, setToken] = useState(current?.token ?? "");
  const [connection, setConnection] = useState(current?.connection ?? "");
  const [open, setOpen] = useState(!current);

  function save() {
    writeApiConfig({ url: url.trim(), token: token.trim(), connection: connection.trim() || undefined });
    setOpen(false);
    onChange?.();
  }

  return (
    <Card>
      <SectionHeader
        title="Platform API"
        description={
          current ? `${current.url} — Speak and transcribe are on.` : "Off until configured: set VITE_PATCHWORK_URL and paste a token, or fill this in."
        }
        action={
          <div className="flex items-center gap-2">
            <Tag size="sm" variant="pastel" radius="full" color={current ? "lime" : "neutral"} className="font-mono text-[11px] uppercase px-2">
              {current ? "configured" : "off"}
            </Tag>
            <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={() => setOpen((v) => !v)}>
              {open ? "Hide" : "Edit"}
            </Button>
          </div>
        }
      />
      {open && (
        <div className="grid gap-3 sm:grid-cols-3 items-end">
          <Input size="sm" appearance="outline" label="Base URL" value={url} onChange={setUrl} placeholder="http://localhost:4000" />
          <Input size="sm" appearance="outline" label="Bearer token" type="password" value={token} onChange={setToken} placeholder="eyJ…" />
          <Input size="sm" appearance="outline" label="Connection (optional)" value={connection} onChange={setConnection} placeholder="conn_…" />
          <div className="sm:col-span-3 flex gap-2">
            <Button size="sm" radius="sm" variant="solid" color="neutral" onPress={save} isDisabled={!url.trim() || !token.trim()}>
              Save
            </Button>
            <span className="text-2xs text-text-light self-center">Stored in this browser only.</span>
          </div>
        </div>
      )}
    </Card>
  );
}
