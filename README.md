# allens-flooring-website
New Allen's Flooring website redesign for Cloudflare Pages

## Contact form configuration

The homepage and contact-page forms post to the Cloudflare Pages Function at
`/api/contact`. The Function sends one email through Resend with the primary
recipient in `To` and the additional recipient in `CC`.

Configure these values under **Workers & Pages → the Pages project → Settings →
Variables and Secrets** for both production and preview as needed:

- `RESEND_API_KEY`: encrypted secret containing the Resend API key.
- `CONTACT_FROM_EMAIL`: a sender on a domain verified in Resend, for example
  `Allen's Carpet & Flooring <forms@allenscarpetinc.com>`.

Redeploy the Pages project after adding or changing either value. Never commit
real API keys to this repository or to a Wrangler `vars` block.
