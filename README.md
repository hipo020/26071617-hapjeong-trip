# 여행 가계부 · Appwrite 공동 저장 버전

Vercel에서 빠르게 열리고, Appwrite에 여행 정보·참여자·지출·영수증을 공동 저장하는 모바일 웹앱입니다.

## 연결 정보

- Appwrite Endpoint: `https://sgp.cloud.appwrite.io/v1`
- Project ID: `6a54f05f000bc614cd40`
- Database ID: `travel-budget`
- 여행정보 Table ID: `trips`
- 참여자 Table ID: `participants`
- 지출내역 Table ID: `expenses`
- 영수증 Bucket ID: `receipts`

## 필요한 Appwrite 구조

### trips
- `name`: Varchar 100, Required
- `startDate`: Varchar 10, Optional
- `endDate`: Varchar 10, Optional

### participants
- `name`: Varchar 100, Required

### expenses
- `dataJson`: Varchar 10000, Required

### receipts
- JPG, JPEG, PNG, WEBP
- 최대 5MB

세 테이블과 버킷 모두 Settings → Permissions에서 `Any` 역할에 Create, Read, Update, Delete 권한이 필요합니다. Row/File security는 끕니다.

## GitHub에 반영하기

이 ZIP의 압축을 푼 뒤, GitHub 저장소 최상단의 기존 파일을 전부 이 파일들로 교체합니다.

- `index.html`
- `styles.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`
- `vercel.json`
- `icons` 폴더

GitHub에 커밋하면 연결된 Vercel 프로젝트가 자동으로 다시 배포합니다.

## 배포 후

이전 버전이 보이면 갤럭시 Chrome에서 페이지를 새로고침하거나 탭을 완전히 닫고 다시 엽니다. 서비스 워커 캐시 이름을 변경해 이전 파일은 자동 정리됩니다.

## 저장 방식

- 여행 이름과 기간: Appwrite `trips`
- 참여자: Appwrite `participants`
- 지출: Appwrite `expenses`
- 영수증: Appwrite Storage `receipts`
- 이 기기의 사용자 선택: 각 브라우저 `localStorage`


## v2.1 수정 사항

- Appwrite SDK 로딩을 공식 CDN 전역 객체 방식으로 변경
- 무한 로딩 방지용 15초 연결 타임아웃 추가
- SDK나 연결 오류가 발생하면 화면에 원인과 다시 불러오기 버튼 표시
- Realtime 연결 실패 시에도 기본 조회·저장 기능은 계속 작동
- 정적 파일 캐시 버전을 변경해 이전 파일이 남는 문제 완화


## v2.2 수정 사항

- Appwrite 공식 Web 문서의 CDN 버전 `17.0.0`으로 수정
- 초기 공동 데이터 조회에 필요하지 않은 Realtime 의존성 제거
- 10초 간격 자동 새로고침으로 다른 사람의 변경사항 반영
- 캐시 버전 변경


## v2.3 수정 사항

- 외부 Appwrite JavaScript SDK 의존성을 완전히 제거
- Appwrite 공식 REST API를 `fetch`로 직접 호출
- TablesDB 행 조회·생성·수정·삭제 지원
- Storage 영수증 업로드·삭제 지원
- SDK 버전 또는 CDN 로딩 문제 방지
- 캐시 버전 변경
