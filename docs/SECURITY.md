# DNS Vision AI — Security Guide

## MVP Security (Current)

### Authentication
- JWT-based authentication with access + refresh tokens
- bcrypt password hashing (12 rounds)
- Role-based access control (admin, operator, viewer)

### Network
- MVP runs on local network only (no internet exposure)
- All services bind to 0.0.0.0 for LAN access
- No SSL/HTTPS in MVP (planned for Phase 2)

### Data
- Camera passwords encrypted at rest (Fernet symmetric encryption)
- PostgreSQL with password authentication
- MinIO with access key authentication

### Best Practices
1. **Change default passwords** immediately after installation
2. **Do not expose** ports 3000, 8000, 1984 to the internet
3. **Use a firewall** to restrict access to trusted IPs on the LAN
4. **Regular backups** using the provided backup script

## Phase 2 Security (Planned)
- SSL/TLS with Let's Encrypt or self-signed certificates
- Nginx reverse proxy
- Rate limiting on API endpoints
- Audit logging
- Session management improvements
- ONVIF credential vault
- AppArmor profiles for containers
