const SENSITIVE_QUERY_KEY = [
	"access(?:_|-)?token",
	"oauth(?:_|-)?token",
	"client(?:_|-)?secret",
	"private(?:_|-)?token",
	"api(?:_|-)?key",
	"x-api-key",
	"x-amz-credential",
	"x-amz-signature",
	"x-amz-security-token",
	"auth",
	"key",
	"password",
	"passwd",
	"token",
].join("|");

const SENSITIVE_QUERY_VALUE = new RegExp(
	`([?&#](?:${SENSITIVE_QUERY_KEY})=)[^&#\\s]+`,
	"giu",
);
const AUTHORIZATION_HEADER = /(authorization\s*:\s*)[^\r\n]*/giu;
const TOKEN_HEADER =
	/((?:private-token|job-token|x-api-key|api-key|api_key)\s*:\s*)[^\s,;]+/giu;

/** Remove credentials while retaining enough diagnostic context for operators. */
export function sanitizeSensitiveDiagnostic(message: string): string {
	return message
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1<redacted>@")
		.replace(SENSITIVE_QUERY_VALUE, "$1<redacted>")
		.replace(AUTHORIZATION_HEADER, "$1<redacted>")
		.replace(TOKEN_HEADER, "$1<redacted>");
}
