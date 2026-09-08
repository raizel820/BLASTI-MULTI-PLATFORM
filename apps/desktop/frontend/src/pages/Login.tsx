import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { Eye, EyeOff, Loader2, Wifi, WifiOff, Cloud, CloudOff, KeyRound } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState('');
  const [cloudAvailable, setCloudAvailable] = useState<boolean | null>(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetUsername, setResetUsername] = useState('');
  const [resetMessage, setResetMessage] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // Check cloud availability on mount
  useEffect(() => {
    const checkCloud = async () => {
      try {
        const baseUrl = window.location.port === '5173' || window.location.port === '3000' ? '' : 'http://127.0.0.1:3080';
        const resp = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
        const data = await resp.json().catch(() => ({}));
        // The health endpoint might indicate cloud connectivity
        setCloudAvailable(resp.ok);
      } catch {
        setCloudAvailable(false);
      }
    };
    checkCloud();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setIsLoggingIn(true);
    setError('');
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetUsername) return;

    setIsResetting(true);
    setResetMessage('');
    try {
      const baseUrl = window.location.port === '5173' || window.location.port === '3000' ? '' : 'http://127.0.0.1:3080';
      const resp = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: resetUsername }),
      });
      const data = await resp.json();
      if (data.success) {
        setResetMessage('If the account exists, a password reset link has been sent. Check the server logs for the reset token.');
      } else {
        setResetMessage(data.error || 'Failed to request password reset');
      }
    } catch {
      setResetMessage('Password reset requires an internet connection.');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-2xl">B</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Welcome to Blasti</h1>
          <p className="text-sm text-muted-foreground mt-1">Queue Management Desktop</p>
        </div>

        {!showForgotPassword ? (
          <>
            {/* Login Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                  placeholder="Enter your username"
                  autoFocus
                  autoComplete="username"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all pr-10"
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isLoggingIn || !username || !password}
                className="w-full py-2.5 rounded-lg bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>
                    {cloudAvailable !== false ? (
                      <><Cloud className="w-4 h-4" /> Sign In</>
                    ) : (
                      <><WifiOff className="w-4 h-4" /> Sign In (Offline)</>
                    )}
                  </>
                )}
              </button>
            </form>

            {/* Forgot Password Link */}
            <button
              onClick={() => setShowForgotPassword(true)}
              className="w-full mt-3 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5 transition-colors"
            >
              <KeyRound className="w-3 h-3" /> Forgot password?
            </button>

            {/* Connection Status */}
            <div className="mt-6 text-center">
              {cloudAvailable === false ? (
                <p className="text-xs text-amber-500 flex items-center justify-center gap-1.5">
                  <WifiOff className="w-3 h-3" /> Offline mode — using cached credentials
                </p>
              ) : cloudAvailable === true ? (
                <p className="text-xs text-emerald-500 flex items-center justify-center gap-1.5">
                  <Cloud className="w-3 h-3" /> Cloud-connected — authenticating online
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Checking connectivity...
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Forgot Password Form */}
            <div className="mb-4">
              <button
                onClick={() => { setShowForgotPassword(false); setResetMessage(''); }}
                className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                ← Back to login
              </button>
            </div>

            <h2 className="text-lg font-semibold text-foreground mb-2">Reset Password</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Enter your username to request a password reset. This requires an internet connection.
            </p>

            <form onSubmit={handleForgotPassword} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={resetUsername}
                  onChange={(e) => setResetUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                  placeholder="Enter your username"
                  autoFocus
                />
              </div>

              {resetMessage && (
                <div className={`text-sm rounded-lg px-3 py-2 ${
                  resetMessage.includes('sent') || resetMessage.includes('exists')
                    ? 'text-emerald-400 bg-emerald-400/10'
                    : 'text-red-400 bg-red-400/10'
                }`}>
                  {resetMessage}
                </div>
              )}

              <button
                type="submit"
                disabled={isResetting || !resetUsername}
                className="w-full py-2.5 rounded-lg bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
              >
                {isResetting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Requesting reset...
                  </>
                ) : (
                  <>
                    <Cloud className="w-4 h-4" /> Request Reset
                  </>
                )}
              </button>
            </form>

            {cloudAvailable === false && (
              <p className="text-xs text-amber-500 mt-4 flex items-center justify-center gap-1.5">
                <CloudOff className="w-3 h-3" /> Password reset requires internet connection
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
