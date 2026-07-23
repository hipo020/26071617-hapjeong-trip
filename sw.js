# 모아트립 이름 변경 가이드

앱 내부에 표시되는 이름은 이미 `모아트립`으로 변경되어 있습니다.

## 추천 이름

- 앱 표시 이름: `모아트립`
- GitHub 저장소: `moatrip-ledger`
- Vercel 프로젝트: `moatrip-ledger`
- Appwrite 프로젝트 표시 이름: `MoaTrip`

## GitHub 저장소 이름 변경

1. 저장소의 `Settings`로 이동
2. `General` → `Repository name`
3. `26071617-hapjeong-trip`을 `moatrip-ledger`로 변경
4. 컴퓨터의 Git 주소가 필요하면 아래 명령으로 변경

```bash
git remote set-url origin https://github.com/사용자이름/moatrip-ledger.git
```

## Vercel 프로젝트 이름 변경

1. 해당 프로젝트의 `Settings`로 이동
2. `General` → `Project Name`
3. `moatrip-ledger`로 변경
4. 새 기본 주소가 생성되면 Appwrite Web Platform에도 새 hostname 추가

## Appwrite

프로젝트의 화면 표시 이름만 `MoaTrip`으로 바꿔도 됩니다.
현재 코드에 들어 있는 Project ID, Database ID, Table ID, Bucket ID는 변경하지 않는 것이 안전합니다.
