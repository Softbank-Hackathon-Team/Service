output "cluster_name" { value = module.env.cluster_name }
output "cluster_location" { value = module.env.cluster_location }
output "db_private_ip" { value = module.db.private_ip }
output "db_name" { value = module.db.db_name }
output "db_user" { value = module.db.user }
# 비밀 "이름"만 (값은 Secret Manager 에만 있다)
output "db_password_secret" { value = module.db.password_secret }
output "connection_name" { value = module.db.connection_name }
