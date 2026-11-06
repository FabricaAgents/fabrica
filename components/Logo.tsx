// The mark: the owner's logo in public/logo.png. Everything that shows the logo, the browser tab icon and the share
// card included, reads it from here.
export const LOGO_SRC = '/logo.png';

export function LogoMark({ size = 30 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="brand__mark" src={LOGO_SRC} width={size} height={size} alt="" />;
}

export function Logo() {
  return (
    <span className="brand">
      <LogoMark />
      <span className="brand__name">Fabrica</span>
    </span>
  );
}
