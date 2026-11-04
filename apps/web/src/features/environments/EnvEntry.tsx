import { go } from '../../app/routes';
import { Icon } from '../../components/ui/Icon';
import { REGISTER_PATH } from './connect';
import s from '../common/page.module.css';

/**
 * "환경 등록하기" 진입점. 새 이전의 출발·도착 목록 끝, 환경 목록 끝, 계정 화면에서 같은 등록 흐름으로 보낸다.
 * pick: 고르는 큰 줄 모양, list: 좁은 목록 줄 모양.
 */
export function RegisterEnvEntry({ variant = 'pick' }: { variant?: 'pick' | 'list' }) {
  const open = () => go(REGISTER_PATH);
  if (variant === 'list') {
    return (
      <button type="button" className={`${s.listButton} ${s.listAdd}`} onClick={open}>
        <span className={s.formRow}>
          <span className="t-label-md">환경 등록하기</span>
          <Icon name="plus" size={14} />
        </span>
        <span className="t-caption c-tertiary">AWS·GCP 계정이나 온프레 클러스터</span>
      </button>
    );
  }
  return (
    <button type="button" className={`${s.pickRow} ${s.pickAdd}`} onClick={open}>
      <span className={s.pickName}>
        <Icon name="plus" />
        <span className={s.pickText}>
          <span className="t-h3">환경 등록하기</span>
          <span className="t-caption c-secondary">계정을 연결해 두면 필요할 때만 권한을 빌려 옵니다</span>
        </span>
      </span>
    </button>
  );
}
