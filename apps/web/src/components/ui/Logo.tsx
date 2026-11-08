import logo from '../../assets/logo.png';
import s from './Logo.module.css';
import { t } from '../../lib/i18n';

// 제품 이름 (11/08 팀 결정: Kross AI). 바꾸면 이 값과 index.html 의 <title> 을 같이 바꾼다.
export const PRODUCT_NAME = 'Kross AI';

/**
 * 팀 로고 (11/08 사용자 제공 그림). 앱 아이콘처럼 둥근 사각형으로 자른다 (모서리 = 한 변의 27.5%, 예전 I빔 아이콘과 같은 비율).
 * public/favicon.svg 는 같은 그림을 같은 모서리로 자른 것이라 바꾸면 둘 다 바꾼다 (src/assets/logo.png 256px)
 */
export function Logo() {
  return (
    <span className={s.root}>
      <img className={s.mark} src={logo} width={40} height={40} alt={t('{0} 로고', { 0: PRODUCT_NAME })} />
      <span className={s.name}>{PRODUCT_NAME}</span>
    </span>
  );
}
