VERIFICATION_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;">
          <tr>
            <td style="padding-bottom:28px;">
              <span style="font-size:14px;font-weight:600;color:#f4f4f5;letter-spacing:0.06em;">FrontDashboard</span>
            </td>
          </tr>
          <tr>
            <td style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
              <h1 style="margin:0 0 10px;font-size:20px;font-weight:600;color:#f4f4f5;line-height:1.3;">Verify your email address</h1>
              <p style="margin:0 0 28px;font-size:14px;line-height:1.65;color:#a1a1aa;">
                Welcome to FrontDashboard. Click the button below to verify your email address and activate your account.
              </p>
              <a href="${verification_url}" style="display:inline-block;background:#f4f4f5;color:#09090b;font-size:14px;font-weight:600;text-decoration:none;padding:11px 28px;border-radius:8px;">
                Verify email
              </a>
              <p style="margin:28px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
                Or paste this link into your browser:<br>
                <span style="color:#a1a1aa;word-break:break-all;">${verification_url}</span>
              </p>
              <p style="margin:16px 0 0;font-size:12px;color:#52525b;">${expiry_text}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                You received this because an account was created with this email address. If this wasn&rsquo;t you, no action is needed.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

EXISTING_ACCOUNT_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>You already have an account</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;">
          <tr>
            <td style="padding-bottom:28px;">
              <span style="font-size:14px;font-weight:600;color:#f4f4f5;letter-spacing:0.06em;">FrontDashboard</span>
            </td>
          </tr>
          <tr>
            <td style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
              <h1 style="margin:0 0 10px;font-size:20px;font-weight:600;color:#f4f4f5;line-height:1.3;">You already have an account</h1>
              <p style="margin:0 0 28px;font-size:14px;line-height:1.65;color:#a1a1aa;">
                Someone just tried to sign up for FrontDashboard with this email address. You already
                have an account, so we didn&rsquo;t create a new one &mdash; sign in instead.
              </p>
              <a href="${login_url}" style="display:inline-block;background:#f4f4f5;color:#09090b;font-size:14px;font-weight:600;text-decoration:none;padding:11px 28px;border-radius:8px;">
                Sign in
              </a>
              <p style="margin:28px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
                Forgot your password? <a href="${reset_url}" style="color:#a1a1aa;">Reset it here</a>.
              </p>
              <hr style="margin:24px 0;border:none;border-top:1px solid #27272a;">
              <p style="margin:0;font-size:12px;color:#52525b;">
                If this wasn&rsquo;t you, no action is needed &mdash; your account was not changed and
                nobody was told whether this address is registered.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                You received this because someone attempted to sign up with this email address.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

PASSWORD_RESET_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;">
          <tr>
            <td style="padding-bottom:28px;">
              <span style="font-size:14px;font-weight:600;color:#f4f4f5;letter-spacing:0.06em;">FrontDashboard</span>
            </td>
          </tr>
          <tr>
            <td style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
              <h1 style="margin:0 0 10px;font-size:20px;font-weight:600;color:#f4f4f5;line-height:1.3;">Reset your password</h1>
              <p style="margin:0 0 28px;font-size:14px;line-height:1.65;color:#a1a1aa;">
                We received a request to reset your FrontDashboard password. Click the button below to choose a new one.
              </p>
              <a href="${reset_url}" style="display:inline-block;background:#f4f4f5;color:#09090b;font-size:14px;font-weight:600;text-decoration:none;padding:11px 28px;border-radius:8px;">
                Reset password
              </a>
              <p style="margin:28px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
                Or paste this link into your browser:<br>
                <span style="color:#a1a1aa;word-break:break-all;">${reset_url}</span>
              </p>
              <p style="margin:16px 0 0;font-size:12px;color:#52525b;">${expiry_text}</p>
              <hr style="margin:24px 0;border:none;border-top:1px solid #27272a;">
              <p style="margin:0;font-size:12px;color:#52525b;">If you didn&rsquo;t request a password reset, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:#3f3f46;">
                You received this because a password reset was requested for this email address.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""
