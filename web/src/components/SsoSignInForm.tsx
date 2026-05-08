import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { identityProviderServiceClient } from "@/connect";
import { absolutifyLink } from "@/helpers/utils";
import { IdentityProvider } from "@/types/proto/api/v1/idp_service_pb";
import { useTranslate } from "@/utils/i18n";
import { storeOAuthState } from "@/utils/oauth";

interface Props {
  redirectPath?: string;
}

const SsoSignInForm = ({ redirectPath }: Props) => {
  const t = useTranslate();
  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await identityProviderServiceClient.listIdentityProviders();
      if (!cancelled) {
        setProviders(response.identityProviders);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableProviders = useMemo(
    () =>
      providers.filter(
        (p) => p.config?.config?.case === "oauth2Config" && p.config.config.value?.authUrl && p.config.config.value?.clientId,
      ),
    [providers],
  );

  const handleSignIn = async (provider: IdentityProvider) => {
    const oauth2 = provider.config?.config?.case === "oauth2Config" ? provider.config.config.value : null;
    if (!oauth2?.authUrl || !oauth2.clientId) return;
    setLoading(true);
    try {
      const redirectUri = absolutifyLink("/auth/callback");
      const { state, codeChallenge } = await storeOAuthState(provider.name, "signin", redirectPath);
      const url = new URL(oauth2.authUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", oauth2.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      if (oauth2.scopes.length > 0) {
        url.searchParams.set("scope", oauth2.scopes.join(" "));
      }
      url.searchParams.set("state", state);
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      window.location.href = url.toString();
    } finally {
      setLoading(false);
    }
  };

  if (availableProviders.length === 0) return null;

  return (
    <div className="w-full flex flex-col gap-2 mt-4">
      {availableProviders.map((provider) => (
        <Button key={provider.name} variant="outline" type="button" disabled={loading} onClick={() => handleSignIn(provider)}>
          {t("common.sign-in-with", { provider: provider.title })}
        </Button>
      ))}
    </div>
  );
};

export default SsoSignInForm;
