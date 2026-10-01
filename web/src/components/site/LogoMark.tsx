/** Three chain layers with a withdrawal passing straight through them (no dependencies: the link-preview image uses it too). */
export function LogoMark({ size }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="#0b0e13">
      <rect x="10" y="2.5" width="4" height="19" rx="2" />
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <rect x="2.5" y={y - 1.1} width="5.8" height="2.2" rx="1.1" />
          <rect x="15.7" y={y - 1.1} width="5.8" height="2.2" rx="1.1" />
        </g>
      ))}
    </svg>
  );
}
