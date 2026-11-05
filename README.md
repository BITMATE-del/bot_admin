# Telegram 그룹 비상 관리자

여러 그룹을 한 봇으로 관리하는 웹 관리자 및 텔레그램 봇입니다.

## 구성
- Node.js + Express / Telegram Bot API
- Neon PostgreSQL 회원 검색 색인 및 관리 감사 기록
- Railway 웹훅 서비스 + 웹 대시보드

## 설정
`.env.example`을 참고하세요. 실제 Bot Token, DB 인증정보, 2차 비밀번호는 GitHub에 커밋하지 않습니다.

## 권한 한계
봇은 그룹 소유자가 될 수 없으며 소유권을 이전할 수 없습니다. 회원 검색은 봇이 관측한 메시지/입장/관리자 정보에 한정됩니다. 봇에게 관리자 임명(`can_promote_members`)을 포함한 적절한 권한이 미리 부여되어야 합니다.
